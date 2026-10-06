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
}

export async function describeWorktree(
	root: string,
	worktree: WorktreeInfo,
	meta: Omit<WorktreeHandoff, keyof WorktreeInfo | "head" | "commits">,
): Promise<WorktreeHandoff> {
	const head = await gitRun(root, ["rev-parse", "--verify", worktree.branch]);
	const count = await gitRun(root, ["rev-list", "--count", `${meta.baseCommit}..${worktree.branch}`]);
	return {
		...worktree, ...meta,
		head: head.ok ? head.stdout.trim() : "unknown",
		commits: count.ok ? Number(count.stdout.trim()) : "unknown",
	};
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function formatHandoff(root: string, entries: WorktreeHandoff[]): string {
	return [
		"## Worktree branches (not merged)",
		...entries.map(e =>
			`#${e.task} ${e.agent} ${e.status === "ok" ? "ready for review" : `${e.status} — not ready`} — branch ${e.branch} · worktree ${e.path} · ${e.commits} commit(s) on ${e.base}@${e.baseCommit} → ${e.head}`),
		...entries.map(e => `Review: git -C ${quote(root)} log --oneline ${quote(`${e.baseCommit}..${e.branch}`)}`),
		"Review and integrate into the named feature branch only with user authorization. Resolve conflicts and test the combined changes. PR merges still require user review and authorization.",
		"Keep these worktrees until integration is verified. Remove only the returned worktree with git worktree remove <path>, then git branch -d <branch>; stop if Git refuses.",
	].join("\n");
}
