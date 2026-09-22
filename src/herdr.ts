/**
 * Optional Herdr observability — no-op outside Herdr.
 *
 * When pi-dispatch runs inside a Herdr-managed pane (HERDR_ENV=1 and
 * HERDR_SOCKET_PATH set), dispatch completion fires a native notification so
 * long fan-outs are visible without watching the TUI. Fire-and-forget:
 * never blocks, never throws, silently disabled everywhere else.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface HerdrResponse {
	pane?: { workspace_id?: string; pane_id?: string };
	tab?: { tab_id?: string };
	root_pane?: { pane_id?: string };
}

/** Bounded CLI transport; callers own non-fatal handling and cleanup. */
export async function herdrCommand(args: string[]): Promise<HerdrResponse> {
	try {
		const { stdout } = await execFileAsync("herdr", args, {
			timeout: 5000,
			maxBuffer: 256 * 1024,
		});
		// Herdr 0.8.2 acknowledges several successful mutations with empty stdout.
		if (!stdout.trim()) return {};
		const result = JSON.parse(stdout).result;
		if (!result) throw new Error("empty Herdr response");
		return result;
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr;
		let reason = "command failed or timed out";
		try {
			const message = JSON.parse(stderr ?? "").error?.message;
			if (typeof message === "string") reason = message;
		} catch { /* no CLI diagnostic */ }
		throw new Error(`Herdr ${args[0]} ${args[1]}: ${reason.slice(0, 240)}`);
	}
}

export function herdrEnabled(): boolean {
	return (
		process.env.HERDR_ENV === "1" &&
		typeof process.env.HERDR_SOCKET_PATH === "string" &&
		process.env.HERDR_SOCKET_PATH.length > 0
	);
}

export interface DispatchSummary {
	mode: string;
	ok: number;
	failed: number;
	aborted: number;
	total: number;
	aggregated: boolean;
	ms: number;
}

/** Fire a Herdr toast notification. Best-effort; errors are swallowed. */
export function notifyDispatchDone(summary: DispatchSummary): void {
	if (!herdrEnabled()) return;
	const ok = summary.failed === 0 && summary.aborted === 0;
	const title = ok
		? `dispatch ${summary.mode}: ${summary.ok}/${summary.total} done`
		: `dispatch ${summary.mode}: ${summary.failed + summary.aborted}/` +
			`${summary.total} failed or aborted`;
	const body =
		`${summary.aggregated ? "aggregated · " : ""}` +
		`${Math.round(summary.ms / 100) / 10}s` +
		(summary.ok > 0 ? ` · ${summary.ok} ok` : "");
	try {
		const child = spawn(
			"herdr",
			["notification", "show", title, "--body", body, "--sound", ok ? "done" : "request"],
			{ detached: true, stdio: "ignore", env: process.env },
		);
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// Observability must never break dispatch.
	}
}
