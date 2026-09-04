/**
 * Optional Herdr arborescence — one viewer Space per `herdr: true` task.
 *
 * Design: panes are pure VIEWERS. Workers keep their hermetic transport
 * (in-process loops / headless child pi with stdio); each Space merely
 * `tail -f`s a per-worker pretty log that this process writes.
 *
 * Nesting: herdr allows exactly ONE lifecycle authority per pane, so
 * sub-agents can never be reported on the master's pane (the pi agent
 * already owns it). Instead each task gets a git worktree Space
 * (`herdr worktree create` from the master's workspace). The Spaces
 * sidebar groups worktree children under the parent repo row, which
 * gives the operator a proper `pi-dispatch (master) → scout-1, scout-2`
 * arborescence. Clicking a child shows that worker's live log tail.
 *
 * Everything here is best-effort and never throws into the dispatch path:
 * Herdr is observability, not a dependency. Failures are stderr-only —
 * pane log content never becomes model-visible (context firewall applies
 * to UI artifacts too).
 *
 * Cleanup contract: success → the worker's Space is removed; failure →
 * the Space is held open with the error message for post-mortem. Log
 * artifacts live under a fresh os.tmpdir() directory that the OS reclaims.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { herdrEnabled } from "./herdr.ts";
import type { WorkerResult } from "./types.ts";

/** Freshly created shells need a beat before pane run lands (direnv, rc files). */
const SHELL_SETTLE_MS = 600;

interface PaneEntry {
	index: number;
	name: string;
	agent: string;
	source: string;
	logPath: string;
	paneId?: string;
	workspaceId?: string;
	/** Branch we created for the view worktree, deleted on removal. */
	branch?: string;
	started?: boolean;
	finished?: boolean;
}

/** Run a herdr CLI command; resolve parsed JSON "result" or null. Never throws. */
async function herdr(args: string[]): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: Record<string, unknown> | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		try {
			const child = spawn("herdr", args, {
				stdio: ["ignore", "pipe", "ignore"],
			});
			let out = "";
			child.stdout.on("data", (d) => {
				out += d.toString();
			});
			child.on("error", () => finish(null));
			child.on("close", (code) => {
				if (code !== 0) return finish(null);
				try {
					const parsed = JSON.parse(out) as {
						result?: Record<string, unknown>;
					};
					finish((parsed.result as Record<string, unknown>) ?? null);
				} catch {
					finish(null);
				}
			});
			const timer = setTimeout(() => {
				child.kill();
				finish(null);
			}, 15_000);
			timer.unref?.();
		} catch {
			finish(null);
		}
	});
}

function firstLine(text: string, maxLen: number): string {
	const line = (text ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
	const clean = line.replace(/\s+/g, " ").trim();
	return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Strictly increasing seq for every report-agent / release-agent call.
 * Workers finish concurrently, so calls from parallel entries interleave —
 * herdr ignores stale sequence numbers from the same source. Initialized
 * from Date.now()*1000 so it never loses a race against a freshly restarted
 * herdr server (same seeding scheme pi's own integration uses).
 */
const reportSeqSeed = Date.now() * 1000;
let reportSeq = reportSeqSeed;
const nextSeq = (): number => (reportSeq += 1);

export class DispatchPanes {
	private entries = new Map<number, PaneEntry>();
	/** Session cwd (realpath) — used as `git -C` target for branch cleanup. */
	private repoDir: string;

	private constructor(private dir: string) {
		this.repoDir = dir;
	}

	/**
	 * Open one worktree Space per flagged task, nested under the master's
	 * repo in the Spaces sidebar. Each Space's root pane tails that
	 * worker's pretty log. Returns null when disabled (outside Herdr),
	 * nothing flagged, or the first Space could not be created (e.g. the
	 * session cwd is not a git repo) — callers proceed identically either
	 * way.
	 */
	static async create(
		flagged: { index: number; agent: string; task: string }[],
		cwd: string,
		_label: string,
	): Promise<DispatchPanes | null> {
		if (!herdrEnabled() || flagged.length === 0) return null;
		const panes = new DispatchPanes("");
		try {
			panes.dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-"));
		} catch {
			return null;
		}

		// Prefer the calling pane's workspace (HERDR_WORKSPACE_ID from the
		// shell that launched pi); fall back to deriving the repo from the
		// session cwd. Both nest as worktree children of the same repo.
		let resolvedCwd = cwd;
		try {
			resolvedCwd = fs.realpathSync(cwd);
		} catch {
			// keep the session cwd as given
		}
		panes.repoDir = resolvedCwd;
		const baseArgs = ["worktree", "create", "--no-focus"];
		const workspace = process.env.HERDR_WORKSPACE_ID;
		if (workspace) {
			baseArgs.push("--workspace", workspace);
		} else {
			baseArgs.push("--cwd", resolvedCwd);
		}
		const branchRand = Math.random().toString(36).slice(2, 8);

		for (const item of flagged) {
			const name = `${item.agent.replace(/[^a-zA-Z0-9_-]/g, "")}-${item.index + 1}`;
			// Own the branch name: herdr keeps the branch around after
			// `worktree remove`, and the dispatch-view- prefix guarantees our
			// cleanup deletes only branches this run created.
			const branch = `dispatch-view-${branchRand}-${item.index + 1}`;
			const res = await herdr(
				[...baseArgs, "--label", name, "--branch", branch],
			);
			const ws = (res?.workspace ?? {}) as Record<string, unknown>;
			const pane = (res?.root_pane ?? {}) as Record<string, unknown>;
			const workspaceId =
				typeof ws.workspace_id === "string" ? ws.workspace_id : undefined;
			const paneId = typeof pane.pane_id === "string" ? pane.pane_id : undefined;
			if (!workspaceId || !paneId) {
				process.stderr.write(
					`[pi-dispatch] panes: worktree create failed for ${name} ` +
						`(panes disabled for this run)\n`,
				);
				continue;
			}
			const entry: PaneEntry = {
				index: item.index,
				name,
				agent: item.agent,
				source: `pi-dispatch-worker-${item.index + 1}`,
				logPath: path.join(panes.dir, `${item.index}-${name}.log`),
				paneId,
				workspaceId,
				branch,
			};
			panes.entries.set(item.index, entry);
			fs.writeFileSync(
				entry.logPath,
				`▼ ${item.agent} — ${firstLine(item.task, 120)}\n`,
			);
			await sleep(SHELL_SETTLE_MS);
			void (async () => {
				await herdr(["pane", "rename", entry.paneId, name]);
				await herdr([
					"pane",
					"run",
					entry.paneId,
					`tail -n +1 -f ${entry.logPath}`,
				]);
				await panes.report(entry, "working", `queued · ${item.agent}`);
			})();
		}
		if (panes.entries.size === 0) return null;
		return panes;
	}

	private async report(
		entry: PaneEntry,
		state: "working" | "idle",
		message: string,
	) {
		if (!entry.paneId) return;
		await herdr([
			"pane",
			"report-agent",
			entry.paneId,
			"--source",
			entry.source,
			"--agent",
			entry.name,
			"--state",
			state,
			"--message",
			firstLine(message, 120),
			"--seq",
			String(nextSeq()),
		]);
	}

	/** Release this entry's lifecycle authority (best-effort, before removal). */
	private async release(entry: PaneEntry) {
		if (!entry.paneId) return;
		await herdr([
			"pane",
			"release-agent",
			entry.paneId,
			"--source",
			entry.source,
			"--agent",
			entry.name,
			"--seq",
			String(nextSeq()),
		]);
	}

	private append(entry: PaneEntry, line: string) {
		try {
			fs.appendFileSync(entry.logPath, `${line}\n`);
		} catch {
			// Log write failures are cosmetic — never fail the dispatch.
		}
	}

	/** Banner when the worker actually starts. */
	start(entryIndex: number, model?: string): void {
		const entry = this.entries.get(entryIndex);
		if (!entry) return;
		entry.started = true;
		this.append(entry, `▶ started${model ? ` · ${model}` : ""}`);
		void this.report(entry, "working", `running · ${entry.agent}`);
	}

	/** Live worker activity (write-tier stream). */
	streamer(entryIndex: number): (line: string) => void {
		return (line: string) => {
			const entry = this.entries.get(entryIndex);
			if (entry) this.append(entry, `  ${line}`);
		};
	}

	/** Final state: remove the Space on success, hold it open on failure. */
	async finish(entryIndex: number, result: WorkerResult): Promise<void> {
		const entry = this.entries.get(entryIndex);
		if (!entry || entry.finished) return;
		entry.finished = true;
		const model = result.model ? ` (${result.model})` : "";
		if (result.status === "ok") {
			this.append(
				entry,
				`✓ done${model} · ${Math.round(result.ms / 100) / 10}s — ${firstLine(result.text, 200)}`,
			);
		} else {
			this.append(
				entry,
				`✗ ${result.status}${model} — ${firstLine(result.error ?? result.text ?? "", 300)}`,
			);
		}
		if (result.status === "ok") {
			await this.report(entry, "idle", "done");
			await this.release(entry);
			await this.removeSpace(entry);
		} else {
			// Held for post-mortem: the operator can click the child Space
			// and read the tail to see where the worker died.
			await this.report(
				entry,
				"idle",
				`${result.status}: ${firstLine(result.error ?? "", 100)}`,
			);
		}
	}

	private async removeSpace(entry: PaneEntry) {
		if (entry.workspaceId) {
			await herdr(["worktree", "remove", "--workspace", entry.workspaceId]);
		}
		if (entry.branch) {
			// herdr leaves the branch behind; argv-array execFile so nothing in
			// the branch name is ever shell-interpreted. Best-effort only.
			try {
				await execFileAsync("git", [
					"-C",
					this.repoDir,
					"branch",
					"-D",
					entry.branch,
				]);
			} catch {
				// Branch already gone or repo moved — cosmetic, never fail.
			}
		}
	}

	/**
	 * Final safety net: close Spaces that never got a finish() — but hold
	 * ones whose worker started (partial logs have post-mortem value when
	 * the dispatch path itself aborted around them).
	 */
	async end(): Promise<void> {
		for (const entry of this.entries.values()) {
			if (entry.finished) continue; // already handled in finish()
			entry.finished = true;
			if (entry.started) continue; // held open on purpose
			this.append(entry, "— dispatch ended before this worker started");
			await this.release(entry);
			await this.removeSpace(entry);
		}
	}
}
