/**
 * Git and GitHub adapters for durable pilot effects. Every operation is an
 * argv call (never a shell string). Observers only read; appliers make one
 * non-forced change. Callers record intent before applying and observe again
 * afterwards, so an operation whose outcome is unknown can be reconciled.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { PullRequestIdentity } from "./contracts.ts";
import { dirtyLines, gitRun, gitThrow } from "../worktree.ts";

const exec = promisify(execFile);

/** Branches no pilot push may target, in addition to allowlisted bases. */
export const PROTECTED_BRANCHES: readonly string[] = Object.freeze(["main", "master", "production"]);

export class EffectBlockedError extends Error {
	override name = "EffectBlockedError";
}

/** `applied`: the world shows the effect. `absent`: provably not applied yet. `blocked`: anything else. */
export type Observation =
	| { readonly state: "applied"; readonly pr?: PullRequestIdentity }
	| { readonly state: "absent" }
	| { readonly state: "blocked"; readonly reason: string };

const blocked = (reason: string): Observation => ({ state: "blocked", reason });

/** Commit SHA of a local branch, or null when the branch does not exist. */
export async function branchSha(repo: string, branch: string): Promise<string | null> {
	const r = await gitRun(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
	return r.ok ? r.stdout.trim() : null;
}

/** Whether `ancestor` is reachable from `descendant`; throws when Git cannot tell. */
export async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
	try {
		await exec("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]);
		return true;
	} catch (error) {
		if ((error as { code?: unknown }).code === 1) return false;
		throw new EffectBlockedError(`Cannot compare ${ancestor} with ${descendant}.`, { cause: error });
	}
}

/** Paths touched between two commits, both sides of renames included. */
export async function changedFiles(repo: string, base: string, head: string): Promise<string[]> {
	const out = await gitThrow(repo, ["diff", "--name-only", "--no-renames", "-z", base, head, "--"]);
	return out.split("\0").filter(Boolean);
}

/** Every path equals an owned file or sits under an owned directory (`dir/`). */
export function outsideOwnership(files: readonly string[], owned: readonly string[]): string[] {
	return files.filter((file) => !owned.some((entry) => entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

async function mainCheckout(repo: string): Promise<string> {
	const common = (await gitThrow(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	return path.dirname(common);
}

/**
 * `<worktreesRoot>/<repo path relative to the workspace>/<branch with / replaced by ->`,
 * where the workspace is the parent of `worktreesRoot`. Repositories outside it are refused.
 */
export async function taskWorktreePath(worktreesRoot: string, repo: string, branch: string): Promise<string> {
	const rel = path.relative(fs.realpathSync(path.dirname(worktreesRoot)), await mainCheckout(repo));
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep)[0] === path.basename(worktreesRoot)) {
		throw new EffectBlockedError(`Repository is not inside the workspace of ${worktreesRoot}.`);
	}
	return path.join(worktreesRoot, rel, branch.replaceAll("/", "-"));
}

export async function worktreeBranch(wtPath: string): Promise<string | null> {
	const r = await gitRun(wtPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	return r.ok ? r.stdout.trim() : null;
}

async function sameRepository(a: string, b: string): Promise<boolean> {
	const common = async (dir: string) => fs.realpathSync((await gitThrow(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
	return (await common(a)) === (await common(b));
}

/**
 * Reconcile-first worktree creation: adopt an exact existing match, create a
 * missing one from `baseSha`, and refuse anything else.
 */
export async function ensureTaskWorktree(repo: string, wtPath: string, branch: string, baseSha: string): Promise<void> {
	const existing = await branchSha(repo, branch);
	if (fs.existsSync(wtPath)) {
		const adopt = await sameRepository(repo, wtPath).catch(() => false)
			&& await worktreeBranch(wtPath) === branch
			&& existing === baseSha
			&& (await dirtyLines(wtPath, false)).length === 0;
		if (adopt) return;
		throw new EffectBlockedError(`Worktree ${wtPath} exists and does not match ${branch} at ${baseSha}.`);
	}
	if (existing !== null && existing !== baseSha) {
		throw new EffectBlockedError(`Branch ${branch} exists at ${existing}, not ${baseSha}.`);
	}
	fs.mkdirSync(path.dirname(wtPath), { recursive: true });
	const args = existing === null ? ["worktree", "add", "-b", branch, wtPath, baseSha] : ["worktree", "add", wtPath, branch];
	await gitThrow(repo, args);
}

export interface RemoteAllow { readonly name: string; readonly url: string }
export interface PublishAllowlist {
	readonly remotes: readonly RemoteAllow[];
	readonly bases: readonly string[];
}
export interface PushTarget { readonly repoRoot: string; readonly remote: string; readonly url: string; readonly branch: string }
export interface PullRequestTarget { readonly repo: string; readonly base: string; readonly head: string }

/** Reject protected or unlisted publication targets before anything is recorded. */
export async function assertPublishTargets(allow: PublishAllowlist, push: PushTarget, pr: PullRequestTarget): Promise<void> {
	const remote = allow.remotes.find((entry) => entry.name === push.remote && entry.url === push.url);
	if (!remote) throw new EffectBlockedError(`Remote ${push.remote} (${push.url}) is not allowlisted.`);
	if (!allow.bases.includes(pr.base)) throw new EffectBlockedError(`Base ${pr.base} is not allowlisted.`);
	const protectedBranch = PROTECTED_BRANCHES.includes(push.branch) || allow.bases.includes(push.branch);
	if (protectedBranch || pr.head !== push.branch) throw new EffectBlockedError(`Refusing to publish ${push.branch} as a pull-request head.`);
	await assertRemoteUrl(push);
}

async function assertRemoteUrl(push: PushTarget): Promise<void> {
	for (const flags of [[], ["--push"]]) {
		const result = await gitRun(push.repoRoot, ["remote", "get-url", ...flags, "--all", push.remote]);
		const urls = result.stdout.trim().split("\n");
		if (!result.ok || urls.length !== 1 || urls[0] !== push.url) {
			throw new EffectBlockedError(`Remote ${push.remote} points at an unapproved fetch or push destination.`);
		}
	}
}

async function remoteSha(push: PushTarget): Promise<string | null> {
	const out = await gitThrow(push.repoRoot, ["ls-remote", "--refs", push.remote, `refs/heads/${push.branch}`]);
	const line = out.split("\n").find((l) => l.endsWith(`\trefs/heads/${push.branch}`));
	return line ? line.split("\t")[0] : null;
}

/** Applied when the remote branch is exactly `sha`; absent when missing or a known ancestor. */
export async function observePush(push: PushTarget, sha: string): Promise<Observation> {
	await assertRemoteUrl(push);
	const current = await remoteSha(push);
	if (current === sha) return { state: "applied" };
	if (current === null) return { state: "absent" };
	const behind = await isAncestor(push.repoRoot, current, sha).catch(() => false);
	return behind ? { state: "absent" } : blocked(`${push.remote}/${push.branch} is at ${current}, which is not an ancestor of ${sha}`);
}

/** Fast-forward push of exactly `sha`; never forced. */
export async function applyPush(push: PushTarget, sha: string): Promise<void> {
	await assertRemoteUrl(push);
	await gitThrow(push.repoRoot, ["push", "--porcelain", push.remote, `${sha}:refs/heads/${push.branch}`]);
}

interface ListedPr { number: number; headRefOid: string; headRefName: string; baseRefName: string }

async function listPullRequests(gh: string, pr: PullRequestTarget): Promise<ListedPr[]> {
	const { stdout } = await exec(gh, [
		"pr", "list", "--repo", pr.repo, "--head", pr.head, "--base", pr.base, "--state", "open",
		"--json", "number,headRefOid,headRefName,baseRefName", "--limit", "10",
	], { timeout: 60_000 });
	const parsed = JSON.parse(stdout) as unknown;
	if (!Array.isArray(parsed)) throw new EffectBlockedError("Unexpected gh pr list output.");
	return parsed as ListedPr[];
}

/** Applied when exactly one open PR has this head, base, and head SHA. */
export async function observePullRequest(gh: string, pr: PullRequestTarget, sha: string): Promise<Observation> {
	const prs = await listPullRequests(gh, pr);
	if (prs.length === 0) return { state: "absent" };
	if (prs.length > 1) return blocked(`${prs.length} open pull requests use ${pr.head} -> ${pr.base}`);
	const [found] = prs;
	const exact = found.headRefOid === sha && found.headRefName === pr.head && found.baseRefName === pr.base;
	if (!exact) return blocked(`Pull request #${found.number} head is ${found.headRefOid}, not ${sha}`);
	return { state: "applied", pr: { repo: pr.repo, number: found.number, headSha: sha } };
}

/** Create one draft pull request. */
export async function applyPullRequest(gh: string, pr: PullRequestTarget, title: string, body: string): Promise<void> {
	await exec(gh, ["pr", "create", "--repo", pr.repo, "--draft", "--base", pr.base, "--head", pr.head, "--title", title, "--body", body], { timeout: 60_000 });
}
