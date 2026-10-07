import type { WorkerResult } from "./types.ts";
import { gitRun, type WorktreeInfo } from "./worktree.ts";

export interface WorktreeHandoff extends WorktreeInfo {
	task: number;
	agent: string;
	status: WorkerResult["status"];
	base: string;
	baseCommit: string;
	head: string;
	commits: number | "unknown";
	error?: string;
}

export async function describeWorktree(
	root: string,
	worktree: WorktreeInfo,
	meta: Omit<WorktreeHandoff, keyof WorktreeInfo | "head" | "commits" | "error">,
): Promise<WorktreeHandoff> {
	const ref = `refs/heads/${worktree.branch}`;
	const [headResult, branch, branchHead] = await Promise.all([
		gitRun(worktree.path, ["rev-parse", "--verify", "HEAD"]),
		gitRun(worktree.path, ["symbolic-ref", "--quiet", "HEAD"]),
		gitRun(root, ["rev-parse", "--verify", ref]),
	]);
	const head = headResult.ok ? headResult.stdout.trim() : "unknown";
	const count = await gitRun(root, ["rev-list", "--count", `${meta.baseCommit}..${head}`]);
	const ancestor = await gitRun(root, ["merge-base", "--is-ancestor", meta.baseCommit, head]);
	let error: string | undefined;
	if (!ancestor.ok) error = "Cannot verify that the worker HEAD descends from its assigned base";
	if (!branchHead.ok || branchHead.stdout.trim() !== head) error = "Assigned branch does not contain the worktree HEAD";
	if (!branch.ok || branch.stdout.trim() !== ref) error = "Worker left its assigned branch; preserve the reported HEAD before integration or cleanup";
	const commits = Number(count.stdout.trim());
	return {
		...worktree, ...meta,
		status: error && meta.status === "ok" ? "error" : meta.status,
		head, error,
		commits: count.ok && Number.isSafeInteger(commits) && commits >= 0 ? commits : "unknown",
	};
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function readiness(entry: WorktreeHandoff): string {
	if (entry.status !== "ok") return `${entry.status} — not ready`;
	return entry.commits === 0 ? "no commits" : "ready for review";
}

export function formatHandoff(root: string, entries: WorktreeHandoff[]): string {
	return [
		"## Worktree branches (not merged)",
		...entries.map(e =>
			`#${e.task} ${e.agent} ${readiness(e)} — branch ${e.branch} · worktree ${e.path} · ${e.commits} commit(s) on ${e.base}@${e.baseCommit} → ${e.head}${e.error ? ` · ${e.error}` : ""}`),
		...entries.map(e => `Review: git -C ${quote(root)} log --oneline ${quote(`${e.baseCommit}..${e.head}`)}`),
		"Review and integrate into the named feature branch only with user authorization. Resolve conflicts and test the combined changes. PR merges still require user review and authorization.",
		"Keep not-ready worktrees for recovery. After integration is verified, remove only the returned clean worktree with git worktree remove <path>, then git branch -d <branch>; stop if Git refuses.",
	].join("\n");
}
