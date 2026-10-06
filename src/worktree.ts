/**
 * Git worktree management for the write tier.
 *
 * Each write-tier task runs in its own worktree on branch
 * `dispatch/<runId>/<taskId>`, in a directory named after the branch under
 * `worktreeRoot()`, so workers can commit without touching the
 * parent tree. Worktrees and committed branches remain for review and integration.
 *
 * All functions use execFile-style git invocation (argv array, never a
 * shell string) so task text can never be shell-interpreted.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

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

/** Central worktree folder. Its parent directory is the workspace. */
function centralRoot(): string {
	return process.env.PI_WORKTREE_ROOT ?? path.join(os.homedir(), "eden", ".worktrees");
}

/** Main checkout of `repoRoot`, which may itself be a linked worktree. */
function mainCheckout(repoRoot: string): string {
	const commonDir = execFileSync(
		"git",
		["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
		{ encoding: "utf-8" },
	).trim();
	return path.dirname(commonDir);
}

/**
 * Directory holding task worktrees. Repos inside the workspace mirror their
 * main checkout's path under the central folder
 * (`~/eden/products/app` -> `~/eden/.worktrees/products/app`); other repos
 * keep worktrees in `<repoRoot>/.dispatch/worktrees`.
 */
export function worktreeRoot(repoRoot: string): string {
	const central = centralRoot();
	const rel = path.relative(path.dirname(central), mainCheckout(repoRoot));
	if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		return path.join(repoRoot, ".dispatch", "worktrees");
	}
	return path.join(central, rel);
}

/** Keep local task worktrees out of status without changing tracked files. */
export function ensureExcluded(repoRoot: string): void {
	if (!worktreeRoot(repoRoot).startsWith(repoRoot + path.sep)) return;
	const common = execFileSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
	const file = path.join(common, "info", "exclude");
	const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	if (current.split("\n").includes(".dispatch/")) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${current.endsWith("\n") || !current ? "" : "\n"}.dispatch/\n`);
}

export async function dirtyLines(repoRoot: string): Promise<string[]> {
	const status = await gitRun(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
	if (!status.ok) throw new Error("Cannot verify working tree");
	return status.stdout.split("\n").map(l => l.trim()).filter(Boolean);
}

export async function assertCleanTree(repoRoot: string): Promise<void> {
	const dirty = await dirtyLines(repoRoot);
	if (dirty.length) throw new Error(`write tier requires a clean working tree at ${repoRoot} — uncommitted: ${dirty.slice(0, 3).join(", ")}`);
}

/** Pin every worker in a call to the same clean feature commit. */
export async function resolveWorktreeTarget(dir: string): Promise<{ root: string; base: string; baseCommit: string }> {
	const root = await getRepoRoot(dir);
	if (!root) throw new Error("dispatch: set target to a clean feature repo root inside the session cwd");
	if (fs.realpathSync(dir) !== fs.realpathSync(root)) throw new Error("dispatch: target must be the repo root");
	await assertCleanTree(root);
	const branch = await gitRun(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const base = branch.stdout.trim();
	if (!branch.ok || !base) throw new Error("dispatch: target must have a feature branch, not detached HEAD");
	if (["main", "master", "production"].includes(base)) throw new Error(`dispatch: check out a feature branch in ${root} first`);
	const baseCommit = (await gitThrow(root, ["rev-parse", "HEAD"])).trim();
	return { root, base, baseCommit };
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
	baseCommit = "HEAD",
): Promise<WorktreeInfo> {
	// Precheck FIRST — before any repo mutation.
	await assertCleanTree(repoRoot);

	const run = safeComponent(runId);
	const id = safeComponent(taskId);
	const branch = `dispatch/${run}/${id}`;
	const wtPath = path.join(worktreeRoot(repoRoot), branch.replaceAll("/", "-"));
	if (fs.existsSync(wtPath)) {
		throw new Error(`worktree path already exists: ${wtPath}`);
	}
	await gitThrow(repoRoot, ["worktree", "add", wtPath, "-b", branch, baseCommit]);
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
 * during setup-failure cleanup. Git refuses unmerged branches. The default is
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
		// Never force removal: Git protects dirty, locked and otherwise unsafe
		// worktrees. Retain both the directory and branch if cleanup is refused.
		if ((await dirtyLines(wtPath)).length > 0) return;
		const removed = await gitRun(repoRoot, ["-c", "status.showUntrackedFiles=all", "worktree", "remove", wtPath]);
		if (!removed.ok) return;
		if (deleteBranch && branch) {
			// Git refuses deletion of unmerged or checked-out branches.
			await gitRun(repoRoot, ["branch", "-d", branch]);
		}
		await gitRun(repoRoot, ["worktree", "prune"]);
	} catch {
		/* never throw: cleanup only */
	}
}

/** Prune missing-worktree metadata only. Age is not proof a worker stopped. */
export async function pruneStale(repoRoot: string): Promise<void> {
	await gitRun(repoRoot, ["worktree", "prune"]);
}
