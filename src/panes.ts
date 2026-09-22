/** Herdr viewer tabs: observability only, never execution or Git worktrees. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { herdrCommand as herdr, herdrEnabled } from "./herdr.ts";
import type { WorkerResult } from "./types.ts";

const MAX_LOG_BYTES = 256 * 1024;
let sequence = Date.now() * 1000;

interface PaneEntry {
	name: string;
	paneId: string;
	tabId: string;
	logPath: string;
	bytes: number;
	queue: Promise<void>;
	finished?: boolean;
}

/** Shell-quote only our generated log path, never a task or model command. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export class DispatchPanes {
	private entries = new Map<number, PaneEntry>();
	private constructor(
		private dir: string,
		private warn: (text: string) => void,
	) {}

	static async create(
		flagged: { index: number; agent: string; task: string }[],
		cwd: string,
		label: string,
		warn: (text: string) => void = () => {},
		signal?: AbortSignal,
	): Promise<DispatchPanes | null> {
		if (!herdrEnabled() || flagged.length === 0 || signal?.aborted) return null;
		let panes: DispatchPanes | undefined;
		try {
			// Resolve the caller, not the user's currently focused workspace.
			const current = await herdr(["pane", "current", "--current"]);
			const workspaceId = current.pane?.workspace_id;
			const parentId = current.pane?.pane_id;
			if (typeof workspaceId !== "string" || typeof parentId !== "string") {
				throw new Error("caller pane unavailable");
			}
			panes = new DispatchPanes(
				fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-")),
				warn,
			);
			for (const item of flagged) {
				if (signal?.aborted) break;
				const name = `${item.agent.replace(/[^a-zA-Z0-9_-]/g, "")}-${item.index + 1}`;
				const res = await herdr([
					"tab",
					"create",
					"--workspace",
					workspaceId,
					"--cwd",
					cwd,
					"--label",
					`${label} · ${name}`,
					"--no-focus",
				]);
				const tabId = res.tab?.tab_id;
				const paneId = res.root_pane?.pane_id;
				if (typeof tabId !== "string" || typeof paneId !== "string") {
					throw new Error("Herdr did not return viewer tab/pane identifiers");
				}
				const entry: PaneEntry = {
					name,
					tabId,
					paneId,
					bytes: 0,
					queue: Promise.resolve(),
					logPath: path.join(panes.dir, `${item.index}.log`),
				};
				panes.entries.set(item.index, entry);
				fs.writeFileSync(entry.logPath, "", { mode: 0o600 });
				panes.append(
					entry,
					`${name} · viewer of worker under ${parentId}\nTask: ${item.task}`,
				);
				// Let shells settle concurrently, rather than delaying every spawn by 600ms.
				entry.queue = (async () => {
					await new Promise((resolve) => setTimeout(resolve, 600));
					await herdr([
						"pane",
						"run",
						paneId,
						`tail -n +1 -f ${shellQuote(entry.logPath)}`,
					]);
				})();
				panes.enqueue(entry, "working", "queued");
			}
			await Promise.all(
				[...panes.entries.values()].map((entry) => entry.queue),
			);
			return panes;
		} catch (error) {
			warn(
				`${String(error)}; viewers incomplete, worker status remains visible in tool output.`,
			);
			// Retain ownership of partially created tabs so end() still cleans them.
			return panes ?? null;
		}
	}

	private append(entry: PaneEntry, line: string): void {
		if (entry.bytes >= MAX_LOG_BYTES) return;
		try {
			// Activity is metadata, not raw tool output. Strip terminal control bytes.
			const text =
				line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, 1000) +
				"\n";
			fs.appendFileSync(entry.logPath, text);
			entry.bytes += Buffer.byteLength(text);
		} catch {
			// Disk observability failures never fail workers.
		}
	}

	private enqueue(
		entry: PaneEntry,
		state: "working" | "idle" | "unknown",
		message: string,
	): void {
		entry.queue = entry.queue
			.then(async () => {
				await herdr([
					"pane",
					"report-agent",
					entry.paneId,
					"--source",
					"pi-dispatch-viewer",
					"--agent",
					entry.name,
					"--state",
					state,
					"--message",
					message.slice(0, 120),
					"--seq",
					String(++sequence),
				]);
			})
			.catch((error) => this.warn(`${entry.name}: ${String(error)}`));
	}

	start(index: number, model?: string): void {
		const entry = this.entries.get(index);
		if (!entry || entry.finished) return;
		const message = model ? `running · ${model}` : "starting";
		this.append(entry, message);
		this.enqueue(entry, "working", message);
	}

	streamer(index: number): (line: string) => void {
		return (line) => {
			const entry = this.entries.get(index);
			if (entry && !entry.finished) this.append(entry, line);
		};
	}

	async finish(index: number, result: WorkerResult): Promise<void> {
		const entry = this.entries.get(index);
		if (!entry || entry.finished) return;
		entry.finished = true;
		const message = `${result.status} · ${result.model ?? "model unresolved"} · ${Math.round(result.ms / 1000)}s`;
		this.append(entry, message);
		this.enqueue(entry, "idle", message);
		await entry.queue;
	}

	async end(): Promise<void> {
		let held = false;
		for (const entry of this.entries.values()) {
			await entry.queue;
			try {
				await herdr(["tab", "close", entry.tabId]);
				fs.rmSync(entry.logPath, { force: true });
			} catch {
				held = true;
				this.enqueue(entry, "unknown", "dispatch ended; viewer cleanup failed");
				await entry.queue;
				this.warn(`Herdr viewer ${entry.tabId} could not be closed.`);
			}
		}
		if (!held) {
			try {
				fs.rmSync(this.dir, { recursive: true, force: true });
			} catch {
				this.warn("Herdr viewer logs could not be removed.");
			}
		}
	}
}
