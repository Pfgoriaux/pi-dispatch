import * as path from "node:path";
import { realpath } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Constrain a requested cwd to the parent session's cwd subtree. `..`, `~`, and
 * symlink escapes are rejected so a prompt-injected task cannot point workers
 * at arbitrary filesystem locations. Returns the canonical path so later
 * steps do not re-follow a symlink.
 */
export async function resolveSessionCwd(
	cwd: string | undefined,
	ctx: ExtensionContext,
	tool: string,
): Promise<string | undefined> {
	const raw = cwd?.trim();
	if (!raw) return undefined;
	const resolved = path.resolve(ctx.cwd, raw);
	let root: string;
	let target: string;
	try {
		[root, target] = await Promise.all([realpath(ctx.cwd), realpath(resolved)]);
	} catch {
		throw new Error(
			`${tool}: cwd does not exist: ${resolved} (it must be inside the session cwd)`,
		);
	}
	if (target !== root && !target.startsWith(root + path.sep)) {
		throw new Error(
			`${tool}: cwd (${resolved}) is outside the session cwd (${ctx.cwd}). ` +
				"Run pi from the target project or use read tools with absolute paths instead.",
		);
	}
	return target;
}
