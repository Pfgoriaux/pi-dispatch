import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gitThrow } from "../worktree.ts";

/** Pin the revision that fixes will modify, not merely the diff's label. */
export async function pinFixHead(pi: ExtensionAPI, cwd: string, pr?: string): Promise<string> {
	const arg = (pr ?? "").trim();
	if (/^-/.test(arg) || /[\x00-\x1f\x7f]/.test(arg)) {
		throw new Error("pr_review: expected a PR number or Git revision, not command options.");
	}
	let target: string;
	if (/^\d+$/.test(arg)) {
		const result = await pi.exec("gh", ["pr", "view", arg, "--json", "headRefOid", "--jq", ".headRefOid"], { cwd, timeout: 15000 });
		target = result.stdout.trim();
		if (result.code !== 0 || result.killed || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(target)) {
			throw new Error("pr_review: cannot verify the PR head; use review-only mode or a local revision range.");
		}
	} else {
		// A single ref is compared with HEAD; ranges name their head on the right.
		const right = arg.split(/\.{2,3}/);
		const ref = right.length > 1 ? right.at(-1) || "HEAD" : "HEAD";
		target = (await gitThrow(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
	}
	await assertFixHead(cwd, target);
	return target;
}

export async function assertFixHead(cwd: string, expected: string): Promise<void> {
	const actual = (await gitThrow(cwd, ["rev-parse", "HEAD"])).trim();
	if (actual !== expected) {
		throw new Error("pr_review: checkout HEAD differs from the reviewed head; refusing automatic fixes/merge-back.");
	}
}
