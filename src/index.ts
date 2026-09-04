/**
 * pi-dispatch — hybrid multi-agent dispatch tool.
 *
 * Modes:
 * - single:   { agent, task }
 * - parallel: { tasks: [{agent, task, cwd?}, ...] }  (fan-out, capped concurrency)
 * - chain:    { chain: [{agent, task}, ...] }        (sequential, `{previous}` placeholder)
 *
 * Double context firewall:
 * 1. Workers return only their final assistant text (never transcripts).
 * 2. With multiple parallel tasks, a separate aggregator agent distills the
 *    N raw outputs into one report before anything reaches the master model.
 *
 * Recursion guard is structural: workers are hermetic AgentSessions loaded
 * with noExtensions/noSkills, so they cannot see or call `dispatch` at all.
 * (A closure depth counter here would measure sibling tool-call concurrency,
 * not nesting, and would misfire on legitimate parallel dispatches — removed
 * after Herdr review.)
 *
 * Per-task `cwd` is confined to the parent session's cwd subtree (realpath
 * checked) — see validateTaskCwd.
 */

import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { agentRosterHelp, discoverAgents } from "./agents.ts";
import { renderDispatchCall, renderDispatchResult } from "./render.ts";
import { findWorkerSession, runWorker, truncateText } from "./worker.ts";
import { notifyDispatchDone } from "./herdr.ts";
import { DispatchPanes } from "./panes.ts";
import { runWorkerProc } from "./worker-proc.ts";
import { mergeWorktreeBranches, type MergeOutcome } from "./merge.ts";
import {
	assertCleanTree,
	createWorktree,
	ensureGitignore,
	getRepoRoot,
	pruneStale,
	removeWorktree,
} from "./worktree.ts";
import type { AgentConfig, DispatchDetails, WorkerResult } from "./types.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_LENGTH = 8;
const MAX_CONCURRENCY = 4;

interface TaskItem {
	agent: string;
	task: string;
	cwd?: string;
	worktree?: boolean;
	/** Opt-in: spawn a Herdr viewer pane for this task (no-op outside Herdr). */
	herdr?: boolean;
}

interface DispatchParams {
	agent?: string;
	task?: string;
	tasks?: TaskItem[];
	chain?: TaskItem[];
	aggregate?: boolean;
	/** Opt-in: persist SDK-tier worker sessions for later resumption. */
	persist?: boolean;
	/** Continue a persisted worker session by its sessionId (requires task). */
	resume?: string;
}

const TaskItemSchema = Type.Object({
	agent: Type.String({ description: "Agent name to run" }),
	task: Type.String({ description: "Self-contained task description" }),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for this task (must be inside the session cwd)",
		}),
	),
	worktree: Type.Optional(
		Type.Boolean({
			description: "Run in an isolated git worktree (write tier, child process)",
		}),
	),
	herdr: Type.Optional(
		Type.Boolean({
			description:
				"Give this task a Herdr viewer pane (sidebar arborescence, live tail of the worker log). No effect outside Herdr",
		}),
	),
});

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const runners = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (cursor < items.length) {
				const index = cursor++;
				results[index] = await fn(items[index], index);
			}
		},
	);
	await Promise.all(runners);
	return results;
}

/**
 * Constrain per-task cwd to the parent session's cwd subtree. `..`, `~`, and
 * symlink escapes are rejected so a prompt-injected task cannot point workers
 * at arbitrary filesystem locations.
 */
async function validateTaskCwd(
	cwd: string | undefined,
	ctx: ExtensionContext,
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
			`dispatch: task cwd does not exist: ${resolved} (tasks must run inside the session cwd)`,
		);
	}
	if (target !== root && !target.startsWith(root + path.sep)) {
		throw new Error(
			`dispatch: task cwd (${resolved}) is outside the session cwd (${ctx.cwd}). ` +
				"Run pi from the target project or use read tools with absolute paths instead.",
		);
	}
	return resolved;
}

function labeledOutputs(results: WorkerResult[]): { text: string; truncated: boolean } {
	let truncated = false;
	const text = results
		.map((r, i) => {
			// Errors are model-visible here too — they go through the same cap.
			const out = truncateText(r.text || r.error || "(no output)");
			truncated = truncated || out.truncated;
			return `## Task ${i + 1} (${r.agent}${r.status === "ok" ? "" : ` — ${r.status}`})\n${out.text}`;
		})
		.join("\n\n");
	return { text, truncated };
}

function sumUsages(results: WorkerResult[]) {
	return results.reduce(
		(acc, r) => {
			if (!r.usage) return acc;
			acc.input += r.usage.input;
			acc.output += r.usage.output;
			acc.cacheRead += r.usage.cacheRead;
			acc.cacheWrite += r.usage.cacheWrite;
			acc.totalTokens += r.usage.totalTokens;
			acc.cost.input += r.usage.cost.input;
			acc.cost.output += r.usage.cost.output;
			acc.cost.cacheRead += r.usage.cost.cacheRead;
			acc.cost.cacheWrite += r.usage.cost.cacheWrite;
			acc.cost.total += r.usage.cost.total;
			return acc;
		},
		{
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	);
}

export default function dispatchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "dispatch",
		label: "Dispatch",
		description:
			"Spawn parallel sub-agents without polluting the main context. " +
			"Workers run in isolated sessions and only their final reports return here. " +
			"Modes: single (agent+task), parallel (tasks array), chain (sequential pipeline with {previous} placeholder). " +
			"Parallel results are distilled by an aggregator agent before returning. " +
			"Tasks with worktree:true run in isolated git worktrees (write tier) whose branches merge back automatically; " +
			"worktree:true is only honored in tasks[] and chain[] modes — single mode always runs in-process.",
		promptSnippet:
			"Fan out work to specialized sub-agents (research, review, confined writes) with context isolation",
		promptGuidelines: [
			"dispatch: Use for parallel exploration, multi-file research, or multi-perspective review instead of doing everything in this session — worker transcripts never enter the main context.",
			"dispatch: Make each task self-contained: include the goal, concrete paths/symbols, and the desired output shape. Workers start with no prior conversation.",
			"dispatch: Prefer parallel tasks over one giant task; N small workers beat one big one (max 8).",
			"dispatch: For tasks that create or edit files, use the writer agent with worktree:true — each runs in its own git worktree and its branch merges back automatically after all workers finish. Requires a committed-clean repo root; writer returns a change summary, not diffs.",
			"dispatch: Do NOT use for trivial single questions a direct read/grep answers faster.",
			"dispatch: Add herdr:true to a task when the operator wants to follow along: it opens a Herdr viewer pane for that worker (live log tail, sidebar arborescence; no effect outside Herdr)."
		],
		parameters: Type.Object({
			agent: Type.Optional(
				Type.String({ description: "Agent name (single mode)" }),
			),
			task: Type.Optional(
				Type.String({ description: "Task description (single mode)" }),
			),
			tasks: Type.Optional(
				Type.Array(TaskItemSchema, {
					description: "Tasks to run in parallel (parallel mode, max 8)",
				}),
			),
			chain: Type.Optional(
				Type.Array(TaskItemSchema, {
					description:
						"Sequential pipeline; reference prior output via {previous} (chain mode, max 8 steps)",
				}),
			),
			aggregate: Type.Optional(
				Type.Boolean({
					description:
						"Distill parallel results through the aggregator agent (default: true for parallel)",
				}),
			),
			persist: Type.Optional(
				Type.Boolean({
					description:
						"Persist worker sessions (opt-in) so they can be resumed later via the resume param",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						"sessionId of a persisted worker session to continue: resumes that worker's full context and prompts it with task",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return await executeDispatch(
				params as DispatchParams,
				signal,
				onUpdate as ((update: unknown) => void) | undefined,
				ctx,
			);
		},
		renderCall: renderDispatchCall as never,
		renderResult: renderDispatchResult as never,
	});

	async function executeDispatch(
		params: DispatchParams,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: ExtensionContext,
	) {
		const dispatchStarted = Date.now();
		const { byName, agents } = discoverAgents(ctx);

		if (params.tasks?.length && params.chain?.length) {
			throw new Error(
				"dispatch: pass only one of tasks[] (parallel mode) or chain[] (chain mode).",
			);
		}

		let mode: DispatchDetails["mode"];
		let items: TaskItem[];
		if (params.tasks && params.tasks.length > 0) {
			mode = "parallel";
			items = params.tasks;
			if (items.length > MAX_PARALLEL_TASKS) {
				throw new Error(
					`dispatch: too many parallel tasks (${items.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				);
			}
		} else if (params.chain && params.chain.length > 0) {
			mode = "chain";
			items = params.chain;
			if (items.length > MAX_CHAIN_LENGTH) {
				throw new Error(
					`dispatch: chain too long (${items.length} steps). Max is ${MAX_CHAIN_LENGTH}.`,
				);
			}
		} else if (params.agent && params.task) {
			mode = "single";
			items = [{ agent: params.agent, task: params.task }];
		} else {
			throw new Error(
				`dispatch: use (agent + task) for single mode, tasks[] for parallel, or chain[] for sequential. Available agents:\n${agentRosterHelp(agents)}`,
			);
		}

		const unknown = items.map((i) => i.agent).filter((name) => !byName.has(name));
		if (unknown.length > 0) {
			throw new Error(
				`dispatch: unknown agent(s): ${unknown.join(", ")}. Available agents:\n${agentRosterHelp(agents)}`,
			);
		}

		// Worktree tasks get their own git worktree — an explicit cwd there is
		// meaningless and conflicting. Checked BEFORE validateTaskCwd so the
		// error the caller sees is the clearer of the two.
		const wantsWorktree = items.some((i) => i.worktree === true);
		if (wantsWorktree) {
			for (const item of items) {
				if (item.worktree === true && item.cwd) {
					throw new Error(
						"dispatch: worktree tasks may not set cwd (each gets its own git worktree)",
					);
				}
			}
		}

		// Validate every per-task cwd up front (fail fast, before any worker runs).
		const taskCwds = await Promise.all(
			items.map((item) => validateTaskCwd(item.cwd, ctx)),
		);

		// ---- Herdr arborescence (opt-in per task: herdr: true) ----
		// Viewer panes only — never a transport. Null outside Herdr or when
		// nothing is flagged; every call inside DispatchPanes is best-effort.
		const paneSession = await DispatchPanes.create(
			items
				.map((item, i) => ({ index: i, agent: item.agent, task: item.task }))
				.filter((_, i) => items[i].herdr === true),
			ctx.cwd,
			`dispatch ${mode} · ${items.length} ${items.length === 1 ? "task" : "tasks"}`,
		);

		// ---- write tier setup (worktree tasks) ----
		const parentModel = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: undefined;
		let repoRoot: string | undefined;
		let runId: string | undefined;
		const randId = () => Math.random().toString(16).slice(2, 6);
		const mergeRecorder: MergeOutcome = { merged: [], failed: [] };
		if (wantsWorktree) {
			const root = await getRepoRoot(ctx.cwd);
			if (!root) {
				throw new Error(
					"dispatch: write tier requires the session cwd to be a git repository " +
						"(git rev-parse --show-toplevel failed)",
				);
			}
			if ((await realpath(ctx.cwd)) !== root) {
				throw new Error(
					`dispatch: write tier requires the session cwd (${ctx.cwd}) to be the git ` +
						`repo root (${root}); start pi there or drop worktree:true from the tasks.`,
				);
			}
			repoRoot = root;
			// Clean tree precheck — fail fast before any worktree is created.
			await assertCleanTree(repoRoot);
			// Keep dispatch-internal files out of the repo's status.
			ensureGitignore(repoRoot);
			// GC stale `.dispatch/worktrees` entries before adding more.
			await pruneStale(repoRoot);
			runId = `run-${Date.now().toString(36)}-${randId()}`;
		}

		const tracker: WorkerResult[] = [];
		let lastEmitAt = 0;
		const emitProgress = () => {
			if (!onUpdate || Date.now() - lastEmitAt < 1000) return;
			lastEmitAt = Date.now();
			// Cap at items.length so the aggregator's completion can't show "N+1/N".
			const done = Math.min(
				tracker.filter((r) => r.status === "ok").length,
				items.length,
			);
			onUpdate({
				content: [
					{
						type: "text",
						text: `dispatch ${mode}: ${done}/${items.length} workers done`,
					},
				],
				// running+total let the renderer distinguish in-flight progress from
				// final results (which never set `running`).
					details: {
					mode,
					items: [...tracker],
					aggregated: false,
					truncated: false,
					running: true,
					total: items.length,
				},
			});
		};

		const runOne = async (
			agent: AgentConfig,
			task: string,
			cwd?: string,
			track = true,
			resumeFile?: string,
		) => {
			let result: WorkerResult;
			try {
				result = await runWorker(agent, task, {
					registry: ctx.modelRegistry,
					fallbackModel: ctx.model,
					cwd: cwd ?? ctx.cwd,
					signal,
					onBoundary: emitProgress,
					persist: params.persist,
					resumeFile,
				});
			} catch (err) {
				// Contain per-task failures (bad agent frontmatter, loader/session
				// setup errors): one broken task must not reject the whole fan-out
				// and strand in-flight workers mid-stream.
				result = {
					agent: agent.name,
					task,
					status: "error",
					text: "",
					error: String(err instanceof Error ? err.message : err),
					ms: 0,
				};
			}
			if (track) {
				tracker.push(result);
				emitProgress();
			}
			return result;
		};

		// ---- resume mode: continue a persisted worker session ----
		if (params.resume) {
			if (!params.task) {
				throw new Error(
					"dispatch: resume requires task (the continuation prompt for that worker)",
				);
			}
			const record = findWorkerSession(params.resume);
			if (!record) {
				throw new Error(
					`dispatch: no persisted worker session with id ${params.resume}. ` +
						"Persist one first with the persist option.",
				);
			}
			const agent = byName.get(record.agent);
			if (!agent) {
				throw new Error(
					`dispatch: session ${params.resume} belongs to agent "${record.agent}", ` +
						"which no longer exists (definition renamed or deleted).",
				);
			}
			// resumeFile opens the persisted worker session with its full history.
			const result = await runOne(agent, params.task, undefined, false, record.file);
			const labeled = labeledOutputs([result]);
			const resumeDetails: DispatchDetails = {
				mode: "resume",
				items: [result],
				aggregated: false,
				truncated: labeled.truncated,
			};
			notifyDispatchDone({
				mode: "resume",
				ok: result.status === "ok" ? 1 : 0,
				failed: result.status === "error" ? 1 : 0,
				aborted: result.status === "aborted" ? 1 : 0,
				total: 1,
				aggregated: false,
				ms: result.ms,
			});
			// The resumed worker's full context continues in its own session;
			// the master still only sees its final text (firewall unchanged).
			let resumeText = labeled.text;
			if (result.status === "ok" && result.sessionId) {
				resumeText += `\n\n[resumed worker session: ${result.sessionId}]`;
			}
			return {
				content: [{ type: "text", text: resumeText }],
				details: resumeDetails,
				usage: result.usage,
			};
		}

		// ---- run ----
		let results: WorkerResult[];
		if (mode === "chain") {
			results = [];
			let previous = "";
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				// Replacer function: `previous` may contain $&, $', $` etc., which
				// have substitution meaning in a plain string replacement.
				const task = item.task.replaceAll("{previous}", () => previous);
				if (repoRoot && item.worktree === true) {
					// Sequential semantics preserved: the step's branch merges back
					// (and its worktree is removed) before the next step runs.
					const worktree = await createWorktree(
						repoRoot,
						runId!,
						`s${i + 1}-${randId()}`,
					);
					let stepMerged = false;
					paneSession?.start(i);
					try {
						const result = await runWorkerProc(byName.get(item.agent)!, task, {
							cwd: worktree.path,
							signal,
							model: parentModel,
							onBoundary: emitProgress,
							onStream: paneSession?.streamer(i),
						});
						tracker.push(result);
						emitProgress();
						results.push(result);
						await paneSession?.finish(i, result);
						previous = result.text;
						// Only a successful step's branch is merged — merging a failed
						// worker's branch would commit broken work. The branch is kept
						// (audit) and reported in merges.failed; the chain itself
						// continues so later steps still run, error visible in the result.
						if (result.status === "ok" && !signal?.aborted) {
							const outcome = await mergeWorktreeBranches(
								repoRoot,
								[worktree.branch],
								{
									signal,
									model: parentModel,
									onBoundary: emitProgress,
								},
							);
							mergeRecorder.merged.push(...outcome.merged);
							mergeRecorder.failed.push(...outcome.failed);
							stepMerged = outcome.merged.includes(worktree.branch);
						} else if (result.status !== "ok" && !signal?.aborted) {
							mergeRecorder.failed.push({
								branch: worktree.branch,
								error: `worker failed (${result.status}); branch kept`,
							});
						}
					} finally {
						// Aborted steps keep their branch (audit); merged ones are deleted.
						await removeWorktree(repoRoot!, worktree.path, {
							deleteBranch: stepMerged,
							branch: worktree.branch,
						});
					}
				} else {
					const result = await runOne(byName.get(item.agent)!, task, taskCwds[i]);
					results.push(result);
					previous = result.text;
				}
			}
		} else {
			// Write tier: create all worktrees up front, sequentially — git
			// worktree creation mutates repo refs and races under concurrency.
			const worktrees: Array<{ path: string; branch: string } | undefined> = [];
			// Per-index final results of worktree workers — used to gate merges
			// on worker status (never merge a failed worker's branch).
			const worktreeResults: Array<WorkerResult | undefined> = [];
			if (wantsWorktree) {
				try {
					for (let i = 0; i < items.length; i++) {
						if (items[i].worktree !== true) continue;
						worktrees[i] = await createWorktree(
							repoRoot!,
							runId!,
							`t${i + 1}-${randId()}`,
						);
					}
				} catch (err) {
					// Never leak already-created worktrees on a setup failure.
					await Promise.allSettled(
						worktrees
							.filter((w): w is { path: string; branch: string } => w !== undefined)
							.map((w) =>
								removeWorktree(repoRoot!, w.path, {
									deleteBranch: true,
									branch: w.branch,
								}),
							),
					);
					throw err;
				}
			}
			try {
				results = await mapWithConcurrency(items, MAX_CONCURRENCY, (item, i) => {
					if (!worktrees[i]) {
					// SDK tier: exactly today's behavior (plus optional pane logging).
					paneSession?.start(i);
					return runOne(byName.get(item.agent)!, item.task, taskCwds[i]).then(
						(result) => {
							void paneSession?.finish(i, result);
							return result;
						},
					);
				}
					paneSession?.start(i);
					return runWorkerProc(byName.get(item.agent)!, item.task, {
						cwd: worktrees[i]!.path,
						signal,
						model: parentModel,
						onBoundary: emitProgress,
						onStream: paneSession?.streamer(i),
					}).then((result) => {
						worktreeResults[i] = result;
						tracker.push(result);
						emitProgress();
						void paneSession?.finish(i, result);
						return result;
					});
				});
			} finally {
				// After ALL tasks finish: merge ONLY the worktree branches of tasks
				// whose worker finished "ok" — merging a failed worker's branch
				// would commit its broken work. Failed-worker branches are reported
				// in merges.failed (reason "worker failed") and kept for a human.
				// On abort: no merge at all (workers were killed via the shared
				// signal), worktrees still removed, branches kept.
				const created: Array<{ path: string; branch: string; index: number }> = [];
				for (let i = 0; i < worktrees.length; i++) {
					const worktree = worktrees[i];
					if (worktree) created.push({ ...worktree, index: i });
				}
				let mergedBranches = new Set<string>();
				if (created.length > 0 && signal?.aborted !== true) {
					const mergeable = created.filter(
						(w) => worktreeResults[w.index]?.status === "ok",
					);
					for (const w of created) {
						if (worktreeResults[w.index]?.status === "ok") continue;
						const status = worktreeResults[w.index]?.status;
						mergeRecorder.failed.push({
							branch: w.branch,
							error:
								status === undefined
									? "worker did not complete; branch kept"
									: `worker failed (${status}); branch kept`,
						});
					}
					if (mergeable.length > 0) {
						const outcome = await mergeWorktreeBranches(
							repoRoot!,
							mergeable.map((w) => w.branch),
							{ signal, model: parentModel, onBoundary: emitProgress },
						);
						mergeRecorder.merged.push(...outcome.merged);
						mergeRecorder.failed.push(...outcome.failed);
						mergedBranches = new Set(outcome.merged);
					}
				}
				for (const w of created) {
					// Merge-failure/aborted/failed-worker branches are kept for a
					// human; merged ones are deleted along with their worktree.
					await removeWorktree(repoRoot!, w.path, {
						deleteBranch: mergedBranches.has(w.branch),
						branch: w.branch,
					});
				}
			}
		}

		// ---- fan-in / aggregation ----
		const doAggregate =
			params.aggregate ??
			(mode === "parallel" && items.length > 1 && results.some((r) => r.status === "ok"));
		let aggregated = false;
		let truncated = false;
		let content: string;

		if (doAggregate && byName.has("aggregator") && results.some((r) => r.status === "ok")) {
			// Worker→aggregator inputs go through the same per-task cap.
			const inputs = results
				.map((r, i) => {
					const out = truncateText(r.text || r.error || "");
					truncated = truncated || out.truncated;
					const head =
						r.status === "ok"
							? ""
							: ` [${r.status.toUpperCase()}${r.error ? `: ${truncateText(r.error).text}` : ""}]`;
					return `### Task ${i + 1} — agent: ${r.agent}${head}\nTask: ${items[i].task}\n\n${out.text}`;
				})
				.join("\n\n---\n\n");
			const aggregateTask =
				`Distill the following worker reports into one coherent answer for the requesting orchestrator. ` +
				`Preserve all concrete findings (files, symbols, line refs, decisions); dedupe overlaps; ` +
				`flag contradictions between workers in a "Disagreements" section; end with a one-line "Confidence" note.\n\n` +
				`Original tasks:\n${items.map((t, i) => `${i + 1}. ${t.task}`).join("\n")}\n\n${inputs}`;
			const aggregateResult = await runOne(
				byName.get("aggregator")!,
				aggregateTask,
				undefined,
				false,
			);
			results = [...results, aggregateResult];
			if (aggregateResult.status === "ok") {
				aggregated = true;
				// Firewall rule: the aggregated text is model-visible, so it goes
				// through the same cap as any worker output.
				const capped = truncateText(aggregateResult.text);
				truncated = truncated || capped.truncated;
				content = capped.text;
			} else {
				const labeled = labeledOutputs(results.slice(0, -1));
				truncated = truncated || labeled.truncated;
				content = labeled.text;
			}
		} else {
			const labeled = labeledOutputs(results);
			truncated = truncated || labeled.truncated;
			content = labeled.text;
		}

		if (!aggregated && results.some((r) => r.status === "error")) {
			const fails = results
				.filter((r) => r.status === "error")
				.map((r) => `- ${r.agent}: ${truncateText(r.error ?? "failed").text}`)
				.join("\n");
			content += `\n\nFailed workers:\n${fails}`;
		}

		if (params.persist) {
			const ids = results
				.filter((r) => r.sessionId)
				.map((r) => r.sessionId)
				.slice(0, 3);
			if (ids.length > 0) {
				content +=
					`\n\n[persisted worker sessions: ${ids.join(", ")}` +
					(results.length > ids.length ? ` (+${results.length - ids.length} more)` : "") +
					` — resume with dispatch({ resume: "<sessionId>", task: "..." })]`;
			}
		}

		const details: DispatchDetails = {
			mode,
			items: results,
			aggregated,
			truncated,
			total: items.length,
			...(mergeRecorder.merged.length > 0 || mergeRecorder.failed.length > 0
				? { merges: mergeRecorder }
				: {}),
		};

		notifyDispatchDone({
			mode,
			ok: results.filter((r) => r.status === "ok").length,
			failed: results.filter((r) => r.status === "error").length,
			aborted: results.filter((r) => r.status === "aborted").length,
			total: items.length,
			aggregated,
			ms: Date.now() - dispatchStarted,
		});

		// Close the arborescence tab (kept open when a pane holds a failure).
		await paneSession?.end();

		return {
			content: [{ type: "text", text: content }],
			details,
			usage: sumUsages(results),
		};
	}
}
