/**
 * Merge orchestration for the write tier.
 *
 * After all write workers finish, their worktree branches merge back into
 * the parent repo sequentially (`git merge --no-edit <branch>`). On the
 * first conflict, a merge agent — a child pi process restricted to the
 * read and edit tools, NOTHING else — edits each conflicted file so the
 * result preserves the semantic intent of BOTH sides. The agent has no
 * shell and cannot run git: this module (the trusted orchestrator) stages
 * exactly the listed conflicted files and completes the merge commit
 * itself. If conflicts or conflict markers remain afterwards, the merge
 * is aborted and the branch is kept for a human.
 *
 * After every successful merge the tree is re-checked for dirt; a dirty
 * tree records a failure for that branch and stops the loop so whatever
 * is left cannot poison the subsequent merges.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./types.ts";
import { runWorkerProc } from "./worker-proc.ts";
import { dirtyLines, gitRun, gitThrow } from "./worktree.ts";

export interface MergeFailure {
	branch: string;
	error: string;
}

export interface MergeOutcome {
	merged: string[];
	failed: MergeFailure[];
}

export interface MergeOptions {
	signal?: AbortSignal;
	/** Parent model as `provider/id` (merge agent inherits it). */
	model?: string;
	onBoundary?: () => void;
}

async function unreadConflicts(repoRoot: string): Promise<string[]> {
	const r = await gitRun(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
	return r.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/** Any leftover conflict markers in the exactly-listed conflicted files? */
async function conflictMarkersRemain(
	repoRoot: string,
	conflicts: string[],
): Promise<boolean> {
	for (const file of conflicts) {
		let content: string;
		try {
			content = fs.readFileSync(path.join(repoRoot, file), "utf-8");
		} catch {
			return true;
		}
		if (/^<{7} /m.test(content) || /^={7}$/m.test(content) || /^>{7} /m.test(content)) {
			return true;
		}
	}
	return false;
}

function firstLine(text: string, max = 200): string {
	const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	const clean = line.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Run the merge agent (child pi process) to resolve the conflicted files of
 * the in-progress merge of `branch`. The agent gets ONLY `read` and `edit`
 * — no bash, no write, no shell — so untrusted conflict payloads can never
 * turn into git commands. It edits files and replies with a summary; git
 * (staging, committing) is done by the caller, never by the agent. Never
 * itself throws; returns ok:false with a short error for the details-only
 * failure report.
 */
async function runMergeAgent(
	repoRoot: string,
	branch: string,
	conflicts: string[],
	options: MergeOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const mergeAgent: AgentConfig = {
		name: "merge-agent",
		description: "Resolves git merge conflicts preserving both sides' intent",
		// Hard restriction: read + edit only. The agent must not be able to
		// run git (or anything else) — the orchestrator does all git work.
		tools: ["read", "edit"],
		model: undefined,
		systemPrompt:
			"You are a merge-resolution agent. You run inside a repository that is mid-merge with " +
			"unresolved conflicts. Resolve each conflicted file so the result preserves the semantic " +
			"intent of BOTH sides — never pick a side blindly. You have ONLY read and edit tools: " +
			"you cannot run git, run shell commands, create, delete, or rename files. Edit ONLY the " +
			"conflicted files listed in the task. If a conflict cannot be resolved faithfully while " +
			"preserving both intents, say so explicitly in your reply and stop.",
		source: "bundled",
		filePath: "",
	};
	const prompt =
		`The repository at ${repoRoot} is mid-merge of branch "${branch}" with unresolved conflicts in:\n` +
		conflicts.map((f) => `- ${f}`).join("\n") +
		"\n\nFor each file: read it, find the `<<<<<<<` / `=======` / `>>>>>>>` conflict markers, " +
		"understand what both sides intended, and edit the file so both intents survive with the " +
		"markers removed. Do not touch any other file. Someone else handles git staging and the " +
		"merge commit — you must not and cannot. Finish with a one-line summary per file.";

	try {
		const result = await runWorkerProc(mergeAgent, prompt, {
			cwd: repoRoot,
			signal: options.signal,
			model: options.model,
			onBoundary: options.onBoundary,
		});
		if (result.status !== "ok") {
			return { ok: false, error: result.error ?? `merge agent status: ${result.status}` };
		}
		// Note: the agent's final text is never trusted as success evidence —
		// the tree state (markers gone, index state) is verified by the caller.
		return { ok: true };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}

/**
 * Post-merge invariant: the tree must be clean (tolerating only our own
 * `.gitignore` bookkeeping line). Returns the dirty lines if not.
 */
async function mergeDirt(repoRoot: string): Promise<string[]> {
	return dirtyLines(repoRoot, true);
}

/** Sequentially merge worktree branches back into the parent repo. */
export async function mergeWorktreeBranches(
	repoRoot: string,
	branches: string[],
	options: MergeOptions = {},
): Promise<MergeOutcome> {
	const merged: string[] = [];
	const failed: MergeFailure[] = [];

	for (const branch of branches) {
		if (options.signal?.aborted) {
			failed.push({ branch, error: "aborted before merge" });
			continue;
		}

		const attempt = await gitRun(repoRoot, ["merge", "--no-edit", branch]);
		if (attempt.ok) {
			// Clean check: a merge commit leaves no dirt behind. If it does,
			// record the failure and stop — do not let it poison the
			// remaining merges.
			const dirt = await mergeDirt(repoRoot);
			if (dirt.length > 0) {
				failed.push({
					branch,
					error: `tree dirty after merge: ${dirt.slice(0, 3).join(", ")}`,
				});
				break;
			}
			merged.push(branch);
			continue;
		}

		const conflicts = await unreadConflicts(repoRoot);
		if (conflicts.length === 0) {
			// Failed outright (unrelated local changes, bad state, ...) —
			// restore the pre-merge state and report.
			await gitRun(repoRoot, ["merge", "--abort"]);
			failed.push({
				branch,
				error: firstLine(attempt.stderr) || "git merge exited non-zero",
			});
			continue;
		}

		// Conflict path: the merge agent (read+edit only, never git)
		// rewrites the conflicted files; we verify the result.
		const agentOutcome = await runMergeAgent(repoRoot, branch, conflicts, options);
		if (!agentOutcome.ok) {
			await gitRun(repoRoot, ["merge", "--abort"]);
			failed.push({ branch, error: `merge agent failed: ${agentOutcome.error}` });
			continue;
		}

		// Stale conflict hunks the agent missed → abort rather than commit
		// conflict markers into history.
		if (await conflictMarkersRemain(repoRoot, conflicts)) {
			await gitRun(repoRoot, ["merge", "--abort"]);
			failed.push({
				branch,
				error: "conflict markers remain after merge agent",
			});
			continue;
		}

		// The merge agent has no shell — the orchestrator stages exactly the
		// conflicted files (never `git add -A`) and completes the merge commit.
		try {
			await gitThrow(repoRoot, ["add", "--", ...conflicts]);
			await gitThrow(repoRoot, ["commit", "--no-edit"]);
		} catch (err) {
			await gitRun(repoRoot, ["merge", "--abort"]);
			failed.push({
				branch,
				error: `completing merge failed: ${firstLine(String(err instanceof Error ? err.message : err))}`,
			});
			continue;
		}

		const remaining = await unreadConflicts(repoRoot);
		if (remaining.length > 0) {
			await gitRun(repoRoot, ["merge", "--abort"]);
			failed.push({
				branch,
				error: `conflicts remain after merge agent: ${remaining.slice(0, 3).join(", ")}`,
			});
			continue;
		}

		// Clean check after merge-agent commits (same invariant as above).
		const dirt = await mergeDirt(repoRoot);
		if (dirt.length > 0) {
			failed.push({
				branch,
				error: `tree dirty after merge commit: ${dirt.slice(0, 3).join(", ")}`,
			});
			break;
		}
		merged.push(branch);
	}

	// Branches skipped because we stopped early are reported, not lost.
	const handled = new Set([...merged, ...failed.map((f) => f.branch)]);
	for (const branch of branches) {
		if (!handled.has(branch)) {
			failed.push({
				branch,
				error: "skipped: dirty tree after an earlier merge",
			});
		}
	}

	// Bookkeeping: ensureGitignore() may have appended `.dispatch/` to the
	// repo's .gitignore, leaving it untracked/modified. Commit exactly that
	// line so the tree ends clean — nothing the workers wrote gets staged.
	if (merged.length > 0) {
		const status = await gitRun(repoRoot, ["status", "--porcelain"]);
		const lines = status.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		const onlyGitignore =
			lines.length > 0 &&
			lines.every((l) => l === "M .gitignore" || l === "?? .gitignore");
		if (onlyGitignore) {
			await gitRun(repoRoot, ["add", "--", ".gitignore"]);
			await gitRun(repoRoot, [
				"commit",
				"-m",
				"chore(pi-dispatch): track .dispatch/ worktree ignore",
			]);
		}
	}

	return { merged, failed };
}
