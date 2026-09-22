/** Native, indented Spaces status rows. No task text, transcripts, or Git state. */
import { herdrCommand, herdrEnabled } from "./herdr.ts";
import type { WorkerActivity } from "./types.ts";

export const SPACE_ROW_COUNT = 12;
export const SPACE_TTL_MS = 60_000;
export const SPACE_REFRESH_MS = 20_000;
const SOURCE = "pi-dispatch-spaces";
let sequence = Date.now() * 1000;

export type SpaceWorker = Pick<WorkerActivity, "index" | "agent" | "status" | "model" | "attempts">;
type Warn = (message: string) => void;

const icons: Record<SpaceWorker["status"], string> = {
	queued: "○", running: "▶", ok: "✓", error: "✗", aborted: "◍",
};

function label(text: string, limit: number): string {
	return Array.from(text.replace(/[\x00-\x1f\x7f-\x9f]/g, "")).slice(0, limit).join("");
}

export function formatSpaceWorker(worker: SpaceWorker): string {
	const model = worker.model?.split("/").at(-1);
	return `${icons[worker.status]} ${label(worker.agent, 24)}-${worker.index + 1}` +
		(model ? ` · ${label(model, 36)}` : "") +
		(worker.attempts > 1 ? ` · ↻${worker.attempts}` : "");
}

/** One coordinator per socket/workspace combines overlapping calls in this host. */
const groups = new Map<string, WorkspaceRows>();

class WorkspaceRows {
	readonly runs = new Map<symbol, { workers: SpaceWorker[]; warn: Warn }>();
	private timer?: ReturnType<typeof setInterval>;
	private pending?: Promise<void>;
	private dirty = false;
	private lastWarn: Warn = () => {};

	constructor(readonly workspace: string) {}

	set(id: symbol, workers: SpaceWorker[], warn: Warn): Promise<void> {
		this.runs.set(id, { workers: workers.map((worker) => ({ ...worker })), warn });
		this.lastWarn = warn;
		if (!this.timer) {
			this.timer = setInterval(() => { void this.publish(); }, SPACE_REFRESH_MS);
			this.timer.unref();
		}
		return this.publish();
	}

	remove(id: symbol): Promise<void> {
		this.runs.delete(id);
		if (this.runs.size === 0) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		return this.publish();
	}

	/** Coalesce bursts into the newest snapshot; never pile up CLI subprocesses. */
	private publish(): Promise<void> {
		this.dirty = true;
		if (!this.pending) {
			this.pending = this.flush().finally(() => {
				this.pending = undefined;
				if (this.dirty) void this.publish();
			});
		}
		return this.pending;
	}

	private async flush(): Promise<void> {
		while (this.dirty) {
			this.dirty = false;
			const workers = [...this.runs.values()].flatMap((run) => run.workers);
			const visible = workers.slice(0, workers.length > SPACE_ROW_COUNT ? SPACE_ROW_COUNT - 1 : SPACE_ROW_COUNT);
			const lines = visible.map(formatSpaceWorker);
			if (workers.length > SPACE_ROW_COUNT) lines.push(`… +${workers.length - visible.length} workers · see Agents`);
			const args = ["workspace", "report-metadata", this.workspace,
				"--source", SOURCE, "--seq", String(++sequence), "--ttl-ms", String(SPACE_TTL_MS)];
			for (let index = 0; index < SPACE_ROW_COUNT; index++) {
				const key = `dispatch_${index + 1}`;
				args.push(...(lines[index] ? ["--token", `${key}=${lines[index]}`] : ["--clear-token", key]));
			}
			try {
				await herdrCommand(args);
			} catch (error) {
				// Retry on the next lifecycle update/heartbeat, not in a tight loop.
				const warnings = this.runs.size ? [...this.runs.values()].map((run) => run.warn) : [this.lastWarn];
				for (const warn of warnings) {
					try { warn(`Spaces worker rows: ${String(error)}`); } catch { /* UI only */ }
				}
			}
		}
	}
}

export class DispatchSpaces {
	private readonly id = Symbol("dispatch");
	private ended = false;
	private constructor(private key: string, private group: WorkspaceRows, private warn: Warn) {}

	static async create(workers: SpaceWorker[], warn: Warn, signal?: AbortSignal): Promise<DispatchSpaces | null> {
		if (!herdrEnabled() || workers.length === 0 || signal?.aborted) return null;
		try {
			const response = await herdrCommand(["pane", "current", "--current"]);
			const workspace = response.pane?.workspace_id;
			if (typeof workspace !== "string") throw new Error("calling workspace unavailable");
			if (signal?.aborted) return null;
			const key = `${process.env.HERDR_SOCKET_PATH}\0${workspace}`;
			let group = groups.get(key);
			if (!group) {
				group = new WorkspaceRows(workspace);
				groups.set(key, group);
			}
			const spaces = new DispatchSpaces(key, group, warn);
			await spaces.update(workers);
			return spaces;
		} catch (error) {
			try { warn(`Spaces worker rows unavailable: ${String(error)}`); } catch { /* UI only */ }
			return null;
		}
	}

	update(workers: SpaceWorker[]): Promise<void> {
		if (this.ended) return Promise.resolve();
		return this.group.set(this.id, workers, this.warn);
	}

	async end(): Promise<void> {
		if (this.ended) return;
		this.ended = true;
		await this.group.remove(this.id);
		if (this.group.runs.size === 0 && groups.get(this.key) === this.group) groups.delete(this.key);
	}
}
