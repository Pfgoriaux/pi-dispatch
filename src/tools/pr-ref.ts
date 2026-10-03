import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateText } from "../worker.ts";

/** A GitHub PR given as a number (session repo) or a URL (explicit owner/repo). */
export interface PrRef {
	number: string;
	repo?: string;
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
/** `git remote -v` fetch line for a github.com https or scp-style ssh URL. */
const REMOTE_LINE = /^(\S+)\s+(?:https:\/\/(?:[^@/\s]+@)?|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/? \(fetch\)$/i;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
/** gh's error when GitHub refuses a diff over 20,000 lines or 300 files. */
const TOO_LARGE = /too_large|HTTP 406|diff exceeded the maximum/i;

export function parsePrRef(arg: string): PrRef | undefined {
	if (/^\d+$/.test(arg)) return { number: arg };
	const match = PR_URL.exec(arg);
	return match ? { repo: match[1], number: match[2] } : undefined;
}

export const prLabel = (ref: PrRef) => (ref.repo ? `${ref.repo} PR #${ref.number}` : `PR #${ref.number}`);

/** `gh` arguments that pin the PR to its repo when the ref names one. */
export const repoArgs = (ref: PrRef) => (ref.repo ? ["-R", ref.repo] : []);

const failure = (r: { stderr: string; code: number }) => truncateText((r.stderr || `exit ${r.code}`).trim()).text;

type Run = (cmd: string, args: string[], timeoutMs?: number) => Promise<string>;

/** Throwing command runner bound to one cwd; errors name the failing step. */
function runner(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Run {
	return async (cmd, args, timeout = 60000) => {
		const result = await pi.exec(cmd, args, { cwd, timeout, signal });
		if (result.code === 0 && !result.killed) return result.stdout;
		throw new Error(`pr_review: ${cmd} ${args[0]} failed: ${failure(result)}`);
	};
}

/** Name of the session remote that fetches `repo` from GitHub, if any. */
async function remoteFor(run: Run, repo: string): Promise<string | undefined> {
	const want = repo.toLowerCase();
	for (const line of (await run("git", ["remote", "-v"])).split("\n")) {
		const match = REMOTE_LINE.exec(line.trim());
		if (match?.[2].toLowerCase() === want) return match[1];
	}
	return undefined;
}

/** Reviewers read the session checkout, so a PR from another repo cannot be reviewed here. */
async function requireRemote(run: Run, repo: string): Promise<string> {
	const remote = await remoteFor(run, repo);
	if (remote) return remote;
	throw new Error(truncateText(
		`pr_review: the PR belongs to ${repo}, but the session repo has no remote for it. ` +
			`Run pr_review from a checkout of ${repo}; reviewers verify findings against the session's code.`,
	).text);
}

/**
 * Diff of a GitHub PR. `gh pr diff` first; when GitHub refuses the diff as too
 * large, fetch the PR head and base from the matching remote and diff locally.
 */
export async function githubDiff(pi: ExtensionAPI, ref: PrRef, cwd: string, signal?: AbortSignal): Promise<string> {
	const run = runner(pi, cwd, signal);
	if (ref.repo) await requireRemote(run, ref.repo);
	const result = await pi.exec("gh", ["pr", "diff", ref.number, ...repoArgs(ref)], { cwd, timeout: 60000, signal });
	if (result.code === 0 && !result.killed) return result.stdout;
	if (!TOO_LARGE.test(result.stderr)) {
		throw new Error(`pr_review: gh diff failed: ${failure(result)}`);
	}
	return fetchedDiff(run, ref);
}

async function fetchedDiff(run: Run, ref: PrRef): Promise<string> {
	const view = await run("gh", ["pr", "view", ref.number, ...repoArgs(ref), "--json", "url,baseRefName,headRefOid"]);
	const info = JSON.parse(view) as { url: string; baseRefName: string; headRefOid: string };
	const remote = await requireRemote(run, parsePrRef(info.url)?.repo ?? info.url);
	// Exact SHAs, not FETCH_HEAD, so a concurrent fetch cannot swap either side.
	const base = (await run("git", ["ls-remote", "--", remote, `refs/heads/${info.baseRefName}`])).split(/\s/)[0];
	const head = info.headRefOid;
	if (!OID.test(base) || !OID.test(head)) throw new Error("pr_review: cannot resolve the PR base and head commits.");
	await run("git", ["fetch", "--no-tags", "--quiet", "--", remote, base, head], 300000);
	const diff = await run("git", ["diff", "--no-ext-diff", "--no-textconv", `${base}...${head}`, "--"], 120000);
	if (diff.trim()) return diff;
	// A merged PR's head is already in its base, so the local diff is empty.
	throw new Error(`pr_review: the local diff of PR #${ref.number} is empty; for a merged PR, pass a rev-range instead.`);
}
