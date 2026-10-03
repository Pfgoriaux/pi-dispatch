import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateText } from "../worker.ts";

/** A GitHub PR given as a number (session repo) or a URL (explicit owner/repo). */
export interface PrRef {
	number: string;
	repo?: string;
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const REMOTE_REPO = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i;
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

/** Name of the session remote that points at `repo` on GitHub, if any. */
async function remoteFor(run: Run, repo: string): Promise<string | undefined> {
	const lines = (await run("git", ["remote", "-v"])).split("\n");
	const want = repo.toLowerCase();
	const line = lines.find((l) => REMOTE_REPO.exec(l.split(/\s+/)[1] ?? "")?.[1].toLowerCase() === want);
	return line?.split(/\s+/)[0];
}

/** Reviewers read the session checkout, so a PR from another repo cannot be reviewed here. */
async function requireRemote(run: Run, repo: string): Promise<string> {
	const remote = await remoteFor(run, repo);
	if (remote) return remote;
	throw new Error(
		`pr_review: the PR belongs to ${repo}, but the session repo has no remote for it. ` +
			`Run pr_review from a checkout of ${repo}; reviewers verify findings against the session's code.`,
	);
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
	const fetchOid = async (src: string) => {
		await run("git", ["fetch", "--no-tags", "--quiet", remote, src], 300000);
		return (await run("git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
	};
	const base = await fetchOid(`refs/heads/${info.baseRefName}`);
	const head = await fetchOid(`refs/pull/${ref.number}/head`);
	if (head !== info.headRefOid) throw new Error("pr_review: the PR head moved while fetching; retry.");
	return run("git", ["diff", "--no-ext-diff", "--no-textconv", `${base}...${head}`, "--"], 120000);
}
