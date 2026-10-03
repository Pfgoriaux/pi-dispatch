/**
 * pr_review — multi-model PR review on top of the dispatch engine.
 *
 * Four in-process workers run in parallel:
 *   1. Opus 5.5: correctness + security
 *   2. Codex Astra: correctness
 *   3. DeepSeek 4.1 Flash (medium thinking): pre-mortem, "why did this break 3 months later?"
 *   4. slop-reviewer (balanced tier): doc rules and unneeded additions
 * A reviewer on the balanced tier then checks each finding against the code
 * and returns one deduplicated report. fix:true hands it to a worktree writer.
 *
 * Diff resolution: GitHub PR number or URL (gh), a git rev-range, a branch compared
 * against HEAD, or the default origin base...HEAD.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { agentRosterHelp, discoverAgents } from "../agents.ts";
import { REVIEW_MODELS, WORKFLOW_EXCLUDED_MODELS, WORKFLOW_FALLBACK_MODELS } from "../profiles.ts";
import { runWorker, sumWorkerUsage, truncateText } from "../worker.ts";
import { ModelDiversity } from "../model-diversity.ts";
import { runWorkerProc } from "../worker-proc.ts";
import { notifyDispatchDone } from "../herdr.ts";
import { DispatchProgress } from "../progress.ts";
import { renderDispatchResult } from "../render.ts";
import {
	correctnessSecurityTask,
	correctnessTask,
	fixTask,
	preMortemTask,
	slopTask,
	verifyAggregateTask,
} from "./pr-review-prompts.ts";
import { pinFixHead, assertFixHead } from "./review-target.ts";
import { githubDiff, parsePrRef, prLabel } from "./pr-ref.ts";
import {
	assertCleanTree,
	createWorktree,
	ensureGitignore,
	getRepoRoot,
	pruneStale,
	removeWorktree,
} from "../worktree.ts";
import { mergeWorktreeBranches } from "../merge.ts";
import type { DispatchDetails, WorkerResult } from "../types.ts";

// ---------------------------------------------------------------------------
// exec / git helpers
// ---------------------------------------------------------------------------

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function exec(
	pi: ExtensionAPI,
	cmd: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ExecResult> {
	const res = await pi.exec(cmd, args, { timeout: timeoutMs, signal });
	return {
		code: typeof res.code === "number" ? res.code : 0,
		stdout: String(res.stdout ?? ""),
		stderr: String(res.stderr ?? ""),
	};
}

async function which(pi: ExtensionAPI, bin: string): Promise<boolean> {
	try {
		const r = await exec(
			pi,
			"bash",
			["-lc", `command -v ${bin} >/dev/null 2>&1`],
			10000,
		);
		return r.code === 0;
	} catch {
		return false;
	}
}

async function defaultBaseRef(
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	const head = await exec(
		pi,
		"git",
		["-C", cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
		15000,
		signal,
	);
	if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
	for (const cand of ["origin/main", "origin/master", "main", "master"]) {
		const r = await exec(
			pi,
			"git",
			["-C", cwd, "rev-parse", "--verify", "--quiet", cand],
			15000,
			signal,
		);
		if (r.code === 0 && r.stdout.trim()) return cand;
	}
	return "main";
}

/**
 * Resolve the diff for the requested PR. `prArg` may be:
 *   - a GitHub PR number or URL (requires `gh`) -> `gh pr diff <n>`, or a
 *     local diff of the fetched PR head when GitHub refuses a large diff
 *   - an explicit git rev-range           -> `git diff <range>`
 *   - a single ref/branch                 -> `git diff <ref>...HEAD`
 *   - empty                               -> `git diff <originBase>...HEAD`
 */
export async function resolveDiff(
	pi: ExtensionAPI,
	prArg: string | undefined,
	cwd: string,
	workdir: string,
	signal?: AbortSignal,
): Promise<{
	diffFile: string;
	label: string;
	empty: boolean;
}> {
	const arg = (prArg ?? "").trim();
	if (/^-/.test(arg) || /[\x00-\x1f\x7f]/.test(arg)) {
		throw new Error(
			"pr_review: expected a PR number or Git revision, not command options.",
		);
	}
	const checked = async (cmd: string, args: string[]) => {
		const result = await pi.exec(cmd, args, { cwd, timeout: 60000, signal });
		if (result.code !== 0 || result.killed) {
			throw new Error(
				`pr_review: ${cmd} diff failed: ${truncateText(result.stderr || `exit ${result.code}`).text}`,
			);
		}
		return result.stdout;
	};
	const gitDiff = (ref: string) =>
		checked("git", [
			"-C",
			cwd,
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			ref,
			"--",
		]);

	let label = "";
	let diff = "";

	const pr = parsePrRef(arg);
	if (pr) {
		if (!(await which(pi, "gh"))) {
			throw new Error(
				`pr_review: PR "${arg}" given but the gh CLI is not available. Pass a git rev-range instead.`,
			);
		}
		label = prLabel(pr);
		diff = await githubDiff(pi, pr, cwd, signal);
	} else if (/\.{2,3}/.test(arg)) {
		label = `range ${arg}`;
		diff = await gitDiff(arg);
	} else if (arg) {
		label = `${arg}...HEAD`;
		diff = await gitDiff(label);
	} else {
		label = `${await defaultBaseRef(pi, cwd, signal)}...HEAD`;
		diff = await gitDiff(label);
	}

	const diffFile = path.join(workdir, "diff.patch");
	fs.writeFileSync(diffFile, diff, "utf8");

	return { diffFile, label, empty: !diff.trim() };
}

// ---------------------------------------------------------------------------
// review steps
// ---------------------------------------------------------------------------

/** Provider error text goes into a markdown heading: keep it short and on one line. */
const oneLine = (text: string) => truncateText(text, 300).text.replace(/\s+/g, " ");

const STEPS = [
	{ agent: "reviewer", task: "Review: correctness + security" },
	{ agent: "reviewer", task: "Review: correctness" },
	{ agent: "scout", task: "Pre-mortem: 3-month failure" },
	{ agent: "slop-reviewer", task: "Slop: docs rules and unneeded additions" },
	{ agent: "reviewer", task: "Verify and aggregate" },
];
const FIX_STEP = { agent: "writer", task: "Fix explicitly authorized findings" };

/** Labeled report for the next step: actual model, status, and failed attempts. */
function report(r: WorkerResult, name: string) {
	return {
		label: `${name} [actual model: ${r.model ?? "unavailable"}] — ${r.status}` +
			(r.failedAttempts ? ` (failed attempts: ${r.failedAttempts.map(oneLine).join("; ")})` : ""),
		text: r.status === "ok"
			? truncateText(r.text || "(no output)").text
			: `[FAILED: ${truncateText(r.error ?? "").text}]`,
	};
}

// ---------------------------------------------------------------------------
// tool registration
// ---------------------------------------------------------------------------

export function registerPrReviewTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pr_review",
		label: "PR Review",
		description:
			"Review a PR or diff with two code reviewers (Opus 5.5, Codex Astra), a 3-month pre-mortem, and a slop review in parallel, then one pass that verifies findings against the code. fix:true fixes validated findings in a worktree that merges back.",
		promptSnippet:
			"Multi-model PR review with optional fixes",
		promptGuidelines: [
			"pr_review: Use when the user asks for a review, or on a PR you opened that changes 100+ lines or touches auth, data, migrations, or infrastructure. Self-review smaller PRs.",
			"pr_review: fix:true requires explicit user intent to change code and a trusted, committed-clean repo root.",
			"pr_review: Always pass intent.",
		],
		parameters: Type.Object({
			herdr: Type.Optional(
				Type.Boolean({
					description: "false disables Herdr viewer tabs",
				}),
			),
			pr: Type.Optional(
				Type.String({
					description:
						"GitHub PR number or URL (in the session repo), rev-range ('main...feature'), or branch vs HEAD. Default: '<origin-default>...HEAD'",
				}),
			),
			fix: Type.Optional(
				Type.Boolean({
					description:
						"Fix validated findings in a worktree and merge back (default false; needs authorization to commit and merge)",
				}),
			),
			intent: Type.Optional(
				Type.String({
					description:
						"The user's request and what the change should do",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const started = Date.now();
			const { byName, agents } = discoverAgents(ctx);

			const required = [
				"reviewer",
				"scout",
				"slop-reviewer",
				"writer",
			];
			const missing = required.filter((n) => !byName.has(n));
			if (missing.length > 0) {
				throw new Error(
					`pr_review: missing bundled agent(s): ${missing.join(", ")}. Available agents:\n${agentRosterHelp(agents)}`,
				);
			}

			const emit = (text: string) =>
				onUpdate?.({ content: [{ type: "text", text }], details: undefined });

			// ---- repo + write-tier preconditions (before any work runs) ----
			const repoRoot = await getRepoRoot(ctx.cwd);
			if (!repoRoot) {
				throw new Error(
					"pr_review: the session cwd must be a git repository (git rev-parse --show-toplevel failed)",
				);
			}
			const wantFix = params.fix === true;
			const atRoot = (await realpath(ctx.cwd)) === repoRoot;
			if (wantFix) {
				if (!ctx.isProjectTrusted())
					throw new Error("pr_review: fixes require a trusted repository.");
				if (!atRoot) {
					throw new Error(
						`pr_review: the fix step requires the session cwd (${ctx.cwd}) to be the git repo root (${repoRoot}). ` +
							"Start pi there, or run pr_review with fix=false.",
					);
				}
				await assertCleanTree(repoRoot);
			}

			const fixHead = wantFix ? await pinFixHead(pi, repoRoot, params.pr) : undefined;

			// ---- resolve the diff ----
			const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-"));
			try {
				const { diffFile, label, empty } = await resolveDiff(
					pi,
					params.pr,
					ctx.cwd,
					workdir,
					signal,
				);

				// PR numbers and named refs are mutable: bind the downloaded diff
				// to the same head on both sides of acquisition, before reviewers run.
				if (wantFix) {
					const afterDiff = await pinFixHead(pi, repoRoot, params.pr);
					if (afterDiff !== fixHead) throw new Error("pr_review: reviewed head changed while acquiring the diff.");
				}

				if (empty)
					return {
						content: [
							{
								type: "text" as const,
								text: `pr_review: ${label} has no changes to review.`,
							},
						],
						details: undefined,
					};

				// ---- review fan-out (context firewall per reviewer) ----
				emit("pr_review: 2 code reviewers, pre-mortem, and slop review, then verification…");
				const progress = new DispatchProgress(
					"parallel",
					[...STEPS, ...(wantFix ? [FIX_STEP] : [])].map((item) => ({ ...item, herdr: params.herdr })),
					onUpdate,
				);
				try {
					await progress.open(ctx.cwd, signal);
					// The two code reviewers share one pool so fallback never gives them the same model.
					// Pre-mortem and slop stay out of it: they must not take a reviewer's last fallback.
					const pool = new ModelDiversity();
					const runStep = (
						index: number,
						task: string,
						model: { spec?: string; excludeModels?: string[]; steerByQuota?: boolean; claim?: boolean; thinking?: string },
					) =>
						progress.run(
							index,
							() =>
								runWorker(byName.get(STEPS[index].agent)!, task, {
									registry: ctx.modelRegistry,
									fallbackModel: ctx.model,
									cwd: ctx.cwd,
									signal,
									thinking: model.thinking ?? "high",
									modelSpec: model.spec,
									excludeModels: [...WORKFLOW_EXCLUDED_MODELS, ...(model.excludeModels ?? [])],
									fallbackModels: WORKFLOW_FALLBACK_MODELS,
									steerByQuota: model.steerByQuota,
									claimModel: model.claim ? pool.worker() : undefined,
									...progress.options(index),
								}),
							signal,
						);

					const reviewerCtx = { cwd: ctx.cwd, diffFile, intent: params.intent };
					// Opus and Astra exclude each other so failover never duplicates a reviewer.
					const [opus, astra, preMortem, slop] = await Promise.all([
						runStep(0, correctnessSecurityTask(reviewerCtx), {
							spec: REVIEW_MODELS.opus,
							excludeModels: [REVIEW_MODELS.astra],
							claim: true,
						}),
						runStep(1, correctnessTask(reviewerCtx), {
							spec: REVIEW_MODELS.astra,
							excludeModels: [REVIEW_MODELS.opus],
							claim: true,
						}),
						runStep(2, preMortemTask(reviewerCtx), {
							spec: REVIEW_MODELS.preMortem,
							steerByQuota: true,
							thinking: "medium",
						}),
						runStep(3, slopTask(reviewerCtx), {}),
					]);
					const reviews = [opus, astra, preMortem, slop];

					if (signal?.aborted) {
						return {
							content: [{ type: "text", text: "pr_review: aborted during review." }],
							details: undefined,
							usage: sumWorkerUsage(reviews),
						};
					}

					if (opus.status !== "ok" && astra.status !== "ok") {
						const errors = reviews
							.map((r, i) => `- ${STEPS[i].task}: ${truncateText(r.error ?? r.status).text}`)
							.join("\n");
						return {
							content: [{ type: "text", text: `pr_review: both code reviewers failed.\n${errors}` }],
							details: {
								mode: "parallel",
								items: reviews,
								aggregated: false,
								truncated: false,
							} satisfies DispatchDetails,
							usage: sumWorkerUsage(reviews),
						};
					}

					const reports = [
						report(opus, "Correctness + security reviewer"),
						report(astra, "Correctness reviewer"),
						report(preMortem, "Pre-mortem"),
						report(slop, "Slop reviewer"),
					];
					const aggregateResult = await runStep(4, verifyAggregateTask({ cwd: ctx.cwd, label, diffFile, reports }), {});
					const findings =
						aggregateResult.status === "ok"
							? truncateText(aggregateResult.text || "(no output)").text
							: [
								`(verification step ${aggregateResult.status}; unverified reports follow)`,
								...reports.map((x) => `### ${x.label}\n${x.text}`),
							].join("\n\n");

					// ---- optional fix step (write tier worktree) ----
					let fixReport = "";
					let fixResult: WorkerResult | undefined;
					const fixRequested = wantFix && aggregateResult.status === "ok";
					if (fixRequested && !signal?.aborted) {
						await assertFixHead(repoRoot, fixHead!);
						await assertCleanTree(repoRoot);
						ensureGitignore(repoRoot);
						await pruneStale(repoRoot);
						emit("pr_review: fixing validated findings in a worktree…");
						const runId = `run-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
						const worktree = await createWorktree(
							repoRoot,
							runId,
							`prfix-${Math.random().toString(16).slice(2, 6)}`,
						);
						let merged = false;
						try {
							fixResult = await progress.run(
								STEPS.length,
								() =>
									runWorkerProc(
										byName.get("writer")!,
										fixTask({ cwd: worktree.path, label, findings }),
										{
											cwd: worktree.path,
											registry: ctx.modelRegistry,
											requireCleanWorktree: true,
											signal,
											model: ctx.model
												? `${ctx.model.provider}/${ctx.model.id}`
												: undefined,
											...progress.options(STEPS.length),
										},
									),
								signal,
							);
							if (fixResult.status === "ok" && !signal?.aborted) {
								await assertFixHead(repoRoot, fixHead!);
								await assertCleanTree(repoRoot);
								const outcome = await mergeWorktreeBranches(
									repoRoot,
									[worktree.branch],
									{
										signal,
										registry: ctx.modelRegistry,
										model: ctx.model
											? `${ctx.model.provider}/${ctx.model.id}`
											: undefined,
									},
								);
								merged = outcome.merged.includes(worktree.branch);
								if (!merged && outcome.failed.length > 0) {
									fixReport = `\n\nFix MERGE FAILED: ${outcome.failed[0].error} (branch kept: ${outcome.failed[0].branch})`;
								}
							} else if (fixResult.status !== "ok") {
								fixReport = `\n\nFix FAILED (${fixResult.status}): ${truncateText(fixResult.error ?? "").text}. Branch kept for inspection: ${worktree.branch}`;
							}
						} finally {
							await removeWorktree(repoRoot, worktree.path, {
								deleteBranch: merged,
								branch: worktree.branch,
							});
						}
						if (merged) {
							fixReport =
								`\n\nFix applied via worktree ` +
								"writer; branch merged back automatically." +
								(fixResult?.text
									? `\nWriter summary: ${truncateText(fixResult.text).text}`
									: "");
						}
					} else if (!wantFix) {
						fixReport =
							"\n\n(Fix skipped: fix=false. Ask to fix the findings, or run dispatch writer when ready.)";
					} else if (!fixRequested) {
						fixReport = "\n\n(Fix skipped: verification did not finish, so no findings are validated.)";
					}

					// ---- notification & result ----
					const items = fixResult
						? [...reviews, aggregateResult, fixResult]
						: [...reviews, aggregateResult];
					notifyDispatchDone({
						mode: "parallel",
						ok: items.filter((r) => r.status === "ok").length,
						failed: items.filter((r) => r.status === "error").length,
						aborted: items.filter((r) => r.status === "aborted").length,
						total: items.length,
						aggregated: aggregateResult.status === "ok",
						ms: Date.now() - started,
					});

					return {
						content: [
							{
								type: "text",
								text: `# PR review — ${label}\n\n${findings}${fixReport}`,
							},
						],
						usage: sumWorkerUsage(items),
						details: {
							mode: "parallel",
							items,
							aggregated: aggregateResult.status === "ok",
							truncated: false,
						} satisfies DispatchDetails,
					};
				} finally {
					await progress.end();
				}
			} finally {
				fs.rmSync(workdir, { recursive: true, force: true });
			}
		},
		renderResult: renderDispatchResult as never,
	});
}
