import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
interface ProcessInfo { pid: number; parent: number; identity: string; zombie: boolean }

async function snapshot(): Promise<ProcessInfo[]> {
	const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,stat=,lstart="], {
		timeout: 2000, maxBuffer: 8 * 1024 * 1024,
	});
	return stdout.split("\n").flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
		return match ? [{ pid: Number(match[1]), parent: Number(match[2]),
			identity: match[4], zombie: match[3].startsWith("Z") }] : [];
	});
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
	// Pi's bash tools may create their own process groups. Signal those too.
	try { process.kill(-pid, signal); } catch { /* not a process-group leader */ }
	try { process.kill(pid, signal); } catch { /* already exited */ }
}

/** Cancel owned descendants before worktree cleanup, including detached tool groups.
 * Snapshotting is best-effort, not containment: already reparented/daemonized
 * processes require an OS sandbox. Identity checks avoid a stale PID kill timer.
 */
export async function stopWorker(
	child: ChildProcess,
	onWarning?: (warning: string) => void,
): Promise<void> {
	if (!child.pid) return;
	if (process.platform === "win32") {
		try { await exec("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 10000 }); }
		catch { child.kill("SIGKILL"); }
		return;
	}
	try {
		const before = await snapshot();
		if (child.exitCode !== null || child.signalCode !== null) return;
		const owned = new Set([child.pid]);
		let previousSize = 0;
		while (previousSize !== owned.size) {
			previousSize = owned.size;
			for (const p of before) if (owned.has(p.parent)) owned.add(p.pid);
		}
		const identities = new Map(before.filter(p => owned.has(p.pid)).map(p => [p.pid, p.identity]));
		for (const pid of [...identities.keys()].reverse()) signalProcess(pid, "SIGTERM");
		// Give normal tools a grace period, but don't return while known live
		// descendants still have access to a worktree about to be removed.
		const deadline = Date.now() + 5000;
		while (true) {
			const remaining = (await snapshot()).filter(p => !p.zombie && identities.get(p.pid) === p.identity);
			if (remaining.length === 0) return;
			if (Date.now() >= deadline) {
				for (const p of remaining.reverse()) signalProcess(p.pid, "SIGKILL");
				return;
			}
			await delay(50);
		}
	} catch {
		onWarning?.("Could not inspect worker descendants; cancellation is limited to the worker process group.");
		// Fallback is immediate, without a stale delayed kill after PID reuse.
		if (child.exitCode === null && child.signalCode === null) signalProcess(child.pid, "SIGKILL");
	}
}
