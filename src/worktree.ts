/**
 * Git worktree management for the write tier.
 *
 * Each write-tier task runs in its own worktree at
 * `<repoRoot>/.dispatch/worktrees/<taskId>` on branch
 * `dispatch/<runId>/<taskId>`, so workers can commit without touching the
 * parent tree. Branches merge back (see merge.ts), then the worktree is
 * removed.
 *
 * All functions use execFile-style git invocation (argv array, never a
 * shell string) so task text can never be shell-interpreted.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface GitRunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Run git, never throwing (for best-effort cleanup paths). */
export async function gitRun(repoRoot: string, args: string[]): Promise<GitRunResult> {
	try {
		const { stdout, stderr } = await execFileP("git", ["-C", repoRoot, ...args], {
			maxBuffer: MAX_BUFFER,
		});
		return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
	} catch (err) {
		const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
		return {
			ok: false,
			stdout: (e.stdout ?? Buffer.from("")).toString(),
			stderr: (e.stderr ?? Buffer.from("")).toString() || (e.message ?? "git failed"),
		};
	}
}

/** Run git and throw with a readable message on failure. */
export async function gitThrow(repoRoot: string, args: string[]): Promise<string> {
	const r = await gitRun(repoRoot, args);
	if (!r.ok) {
		const why = r.stderr.trim() || r.stdout.trim() || "unknown error";
		throw new Error(`git ${args[0]} failed: ${why}`);
	}
	return r.stdout;
}

/** Repo root of `cwd` via `git rev-parse --show-toplevel`, or null. */
export async function getRepoRoot(cwd: string): Promise<string | null> {
	const r = await gitRun(cwd, ["rev-parse", "--show-toplevel"]);
	const root = r.stdout.trim();
	return r.ok && root ? root : null;
}

/**
 * Sanitize to a safe fs/branch path component. Traversal and ref-injection
 * forms are rejected outright (never cleaned up): ".", "..", empty, or
 * anything containing a separator — those could escape
 * `.dispatch/worktrees/` or forge malformed branch names.
 */
function safeComponent(s: string): string {
	const trimmed = s.trim();
	if (
		trimmed === "" ||
		trimmed === "." ||
		trimmed === ".." ||
		trimmed.includes("/") ||
		trimmed.includes("\\")
	) {
		throw new Error(
			`dispatch: unsafe worktree path component rejected: ${JSON.stringify(s)}`,
		);
	}
	return trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

export function worktreeRoot(repoRoot: string): string {
	return path.join(repoRoot, ".dispatch", "worktrees");
}

/**
 * Add `.dispatch/` to the repo's .gitignore if not already covered.
 * Returns true when the file was modified.
 */
export function ensureGitignore(repoRoot: string): boolean {
	const gitignorePath = path.join(repoRoot, ".gitignore");
	let current: string;
	try {
		current = fs.readFileSync(gitignorePath, "utf-8");
	} catch {
		current = "";
	}
	if (/^\s*\.dispatch\/\s*$/m.test(current)) return false;
	const next = current.length === 0
		? ".dispatch/\n"
		: current.endsWith("\n")
			? `${current}.dispatch/\n`
			: `${current}\n.dispatch/\n`;
	fs.mkdirSync(path.dirname(gitignorePath), { recursive: true });
	fs.writeFileSync(gitignorePath, next);
	return true;
}

/**
 * Dirty if any status line remains after tolerating the one change this
 * module itself introduces: an appended `.dispatch/` line in .gitignore —
 * tracked ("M .gitignore") or newly created ("?? .gitignore", when
 * ensureGitignore had to create the file). A .gitignore that was already
 * dirty for other reasons is NOT tolerated — it fails the first precheck
 * before ensureGitignore ever writes, so an unrelated diff here is still
 * reported as real uncommitted work.
 */
export async function dirtyLines(
	repoRoot: string,
	tolerateGitignoreAppend: boolean,
): Promise<string[]> {
	const status = await gitRun(repoRoot, ["status", "--porcelain"]);
	const lines = status.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (!tolerateGitignoreAppend) return lines;

	// Allow both "M .gitignore" and "?? .gitignore" — the check's purpose is
	// catching real uncommitted work, not our own bookkeeping line.
	const isGitignoreLine = (l: string) => l === "M .gitignore" || l === "?? .gitignore";
	if (!lines.some(isGitignoreLine)) return lines;
	if (!lines.every(isGitignoreLine)) return lines;

	if (lines.includes("M .gitignore")) {
		// Tracked `.gitignore`: only tolerate a diff that purely appends the
		// `.dispatch/` line.
		const diff = await gitRun(repoRoot, ["diff", "--", ".gitignore"]);
		const changes = diff.stdout
			.split("\n")
			.filter(
				(l) =>
					(l.startsWith("+") || l.startsWith("-")) &&
					!l.startsWith("+++") &&
					!l.startsWith("---"),
			);
		const onlyDispatchAppend =
			changes.length > 0 &&
			changes.every((l) => l.startsWith("+") && /^\+\s*\.dispatch\/\s*$/.test(l));
		return onlyDispatchAppend ? [] : lines;
	}

	// Untracked ("??") `.gitignore`: newly created by ensureGitignore — its
	// whole content must be only our `.dispatch/` line(s).
	try {
		const content = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf-8");
		const onlyOurs = content
			.split("\n")
			.filter((l) => l.trim() !== "")
			.every((l) => /^\s*\.dispatch\/\s*$/.test(l));
		return onlyOurs ? [] : lines;
	} catch {
		return lines;
	}
}

/**
 * Write-tier precheck: the parent tree must be clean. `git worktree add` is
 * safe on a dirty tree, but merging the branches back later is not, and a
 * clean tree is the only way to attribute every change to its worker.
 */
export async function assertCleanTree(repoRoot: string): Promise<void> {
	const dirty = await dirtyLines(repoRoot, true);
	if (dirty.length > 0) {
		throw new Error(
			"write tier requires a clean working tree — commit or stash first " +
				`(uncommitted: ${dirty.slice(0, 3).join(", ")})`,
		);
	}
}

export interface WorktreeInfo {
	path: string;
	branch: string;
}

/** Create an isolated worktree + branch for one write-tier task. */
export async function createWorktree(
	repoRoot: string,
	runId: string,
	taskId: string,
): Promise<WorktreeInfo> {
	// Precheck FIRST — before any repo mutation.
	await assertCleanTree(repoRoot);

	const run = safeComponent(runId);
	const id = safeComponent(taskId);
	const wtPath = path.join(worktreeRoot(repoRoot), id);
	const branch = `dispatch/${run}/${id}`;
	if (fs.existsSync(wtPath)) {
		throw new Error(`worktree path already exists: ${wtPath}`);
	}
	await gitThrow(repoRoot, ["worktree", "add", wtPath, "-b", branch]);
	return { path: wtPath, branch };
}

/** Branch checked out in a worktree, from `git worktree list --porcelain`. */
export async function branchOfWorktree(
	repoRoot: string,
	wtPath: string,
): Promise<string | undefined> {
	const r = await gitRun(repoRoot, ["worktree", "list", "--porcelain"]);
	if (!r.ok) return undefined;
	let current: string | null = null;
	for (const line of r.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = line.slice("worktree ".length).trim();
			continue;
		}
		if (current === wtPath && line.startsWith("branch ")) {
			return line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
		}
	}
	return undefined;
}

/**
 * Remove a worktree (idempotent — never throws on a missing worktree).
 * `deleteBranch` deletes the task branch; pass false to keep it for audit
 * (aborted dispatches, failed merges, failed workers). The default is
 * normalized inside so that `removeWorktree(root, path, {})` truly means
 * `{ deleteBranch: true }`.
 */
export async function removeWorktree(
	repoRoot: string,
	wtPath: string,
	options: { deleteBranch?: boolean; branch?: string } = {},
): Promise<void> {
	const deleteBranch = options.deleteBranch ?? true;
	try {
		const branch = options.branch ?? (await branchOfWorktree(repoRoot, wtPath));
		// Best-effort in every step: a half-dead worktree must not break cleanup.
		await gitRun(repoRoot, ["worktree", "remove", "--force", wtPath]);
		try {
			fs.rmSync(wtPath, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		if (deleteBranch && branch) {
			// A branch still checked out elsewhere can't be deleted; force is
			// fine because either it was merged or the operator chose removal.
			await gitRun(repoRoot, ["branch", "-D", branch]);
		}
		await gitRun(repoRoot, ["worktree", "prune"]);
	} catch {
		/* never throw: cleanup only */
	}
}

/** Best-effort remove of several worktrees. */
export async function removeWorktrees(repoRoot: string, paths: string[]): Promise<void> {
	await Promise.allSettled(paths.map((p) => removeWorktree(repoRoot, p)));
}

/**
 * Startup GC (best-effort, never throws): remove `.dispatch/worktrees/*`
 * entries whose branch no longer exists or that are older than 24h (mtime).
 * Branches of age-GC'd worktrees are kept — only the worktree entry goes.
 */
export async function pruneStale(repoRoot: string): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(worktreeRoot(repoRoot), { withFileTypes: true });
	} catch {
		return;
	}
	await Promise.allSettled(
		entries.map(async (entry) => {
			try {
				if (!entry.isDirectory()) return;
				const wtPath = path.join(worktreeRoot(repoRoot), entry.name);
				const stat = (() => {
					try {
						return fs.statSync(wtPath);
					} catch {
						return null;
					}
				})();
				if (!stat) {
					await removeWorktree(repoRoot, wtPath, { deleteBranch: false });
					return;
				}
				const branch = await branchOfWorktree(repoRoot, wtPath);
				const branchMissing =
					branch === undefined ||
					!(await gitRun(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`])).ok;
				const stale = branchMissing || stat.mtimeMs < Date.now() - STALE_AFTER_MS;
				if (stale) {
					await removeWorktree(repoRoot, wtPath, {
						deleteBranch: false, // keep branches for audit
						branch,
					});
				}
			} catch {
				/* best-effort */
			}
		}),
	);
}
