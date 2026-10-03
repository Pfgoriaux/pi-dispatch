/**
 * Per-task cwd confinement. A task may start inside the session cwd subtree
 * or inside another checkout of the session's Git repository (a linked
 * worktree, which may live outside the session cwd). `..`, `~`, and symlink
 * escapes are resolved with realpath first, so a prompt-injected task cannot
 * point workers at arbitrary filesystem locations. This is not a sandbox.
 */

import * as path from "node:path";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isInside(target: string, root: string): boolean {
	return target === root || target.startsWith(root + path.sep);
}

/** Real path of the repository's shared Git directory, or undefined outside Git. */
async function gitCommonDir(dir: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ encoding: "utf-8" },
		);
		return await realpath(stdout.trim());
	} catch {
		return undefined;
	}
}

async function sameRepository(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([gitCommonDir(a), gitCommonDir(b)]);
	return left !== undefined && left === right;
}

export async function validateTaskCwd(
	cwd: string | undefined,
	sessionCwd: string,
): Promise<string | undefined> {
	const raw = cwd?.trim();
	if (!raw) return undefined;
	const resolved = path.resolve(sessionCwd, raw);
	let root: string;
	let target: string;
	try {
		[root, target] = await Promise.all([realpath(sessionCwd), realpath(resolved)]);
	} catch {
		throw new Error(`dispatch: task cwd does not exist: ${resolved}`);
	}
	if (isInside(target, root) || await sameRepository(root, target)) return resolved;
	throw new Error(
		`dispatch: task cwd (${resolved}) is outside the session cwd (${sessionCwd}) ` +
			"and is not a worktree of the session's Git repository. " +
			"Run pi from the target project or use read tools with absolute paths instead.",
	);
}
