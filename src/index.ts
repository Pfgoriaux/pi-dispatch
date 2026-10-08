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
 * checked) — see resolveSessionCwd.
 */

import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { agentRosterHelp, discoverAgents } from "./agents.ts";
import { expandModelSpec, isProfileTier, tierThinking } from "./profiles.ts";
import { renderDispatchCall, renderDispatchResult } from "./render.ts";
import { findWorkerSession, runWorker, truncateText } from "./worker.ts";
import { notifyDispatchDone } from "./herdr.ts";
import { DispatchProgress } from "./progress.ts";
import { resolveSessionCwd } from "./session-cwd.ts";
import { runWorkerProc } from "./worker-proc.ts";
import { describeWorktree, formatHandoff, type WorktreeHandoff } from "./handoff.ts";
import {
	createWorktree,
	ensureExcluded,
	resolveWorktreeTarget,
	resolveWorktreeTargetDir,
	pruneStale,
	removeWorktree,
} from "./worktree.ts";
import type { AgentConfig, DispatchDetails, WorkerResult } from "./types.ts";
import { registerFeaturePlanTool } from "./tools/feature-plan.ts";
import { registerPrReviewTool } from "./tools/pr-review.ts";
import { registerCouncilTool } from "./tools/council.ts";
import { registerDurableBatchTool } from "./tools/durable-batch.ts";
import { registerHerdrWatch } from "./herdr-watch.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_LENGTH = 8;
const MAX_CONCURRENCY = 4;

interface TaskItem {
	agent: string;
	task: string;
	cwd?: string;
	worktree?: boolean;
	/** Herdr viewer defaults on inside Herdr; false opts out. */
	herdr?: boolean;
	/** Optional per-task model override: effort tier (`cheap`/`balanced`/`precise`/`long`) or explicit `provider/id`. Skips rosters. */
	model?: string;
}

interface DispatchParams {
	agent?: string;
	task?: string;
	tasks?: TaskItem[];
	chain?: TaskItem[];
	aggregate?: boolean;
	target?: string;
	herdr?: boolean;
	/** Opt-in: persist SDK-tier worker sessions for later resumption. */
	persist?: boolean;
	/** Continue a persisted worker session by its sessionId (requires task). */
	resume?: string;
}

const TaskItemSchema = Type.Object({
	agent: Type.String({ description: "Agent name from the Dispatch agents roster" }),
	task: Type.String({ description: "Self-contained task description" }),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for this task (must be inside the session cwd)",
		}),
	),
	worktree: Type.Optional(
		Type.Boolean({
			description:
				"Run in an isolated git worktree (tasks mode only; required for writer)",
		}),
	),
	herdr: Type.Optional(
		Type.Boolean({
			description:
				"false disables this task's Herdr viewer tab",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Tier (cheap/balanced/precise/long) or provider/id; overrides the agent's model",
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

function labeledOutputs(results: WorkerResult[]): {
	text: string;
	truncated: boolean;
} {
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
	registerHerdrWatch(pi);
	pi.on("before_agent_start", (event, ctx) => {
		if (Number(process.env.PI_DISPATCH_DEPTH) > 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n## Dispatch agents\nUse these exact names; never invent an agent name; skill role labels are not agent names. Workers do not inherit your tools; configured Linkup tools are added. Shell access is not a sandbox.\n${agentRosterHelp(discoverAgents(ctx).agents)}` };
	});

	pi.registerTool({
		name: "dispatch",
		exposure: "model-only",
		label: "Dispatch",
		description:
			"Run agents from the Dispatch agents roster in isolated sessions; only final reports return. " +
			"Modes: single (agent+task), parallel (tasks; an aggregator merges reports), chain (sequential; {previous} inserts the prior output). " +
			"worktree:true (tasks only) runs writers in isolated worktrees; committed branches are returned, not merged.",
		promptSnippet:
			"Get an advisor's second opinion or delegate parallel or context-heavy work",
		promptGuidelines: [
			"dispatch: Select by required capabilities before model strength. Scout locates code; investigator diagnoses code/runtime; advisor judges decisions. Check the live roster: model choice cannot grant tools.",
			"dispatch: Use one advisor for consequential trade-offs, stuck work, or unresolved risks. Otherwise delegate 3+ independent tasks, context-heavy work, or explicit requests. Do routine work directly; repeat consultations only with new evidence.",
			"dispatch: Supply goal, paths, constraints, and output shape. Workers do not see this conversation or automatically inherit its instructions.",
			"dispatch: Worker completion is not task completion. Evaluate returned checks against the user's scope and safety rules. Complete authorized verification; report specific access/approval blockers and what remains unverified.",
			"dispatch: Writers require tasks with worktree:true and authorization to commit. Set target to a clean feature checkout when needed. Review returned branches, integrate only with authorization, then run dependent tasks. PR merges require user review and authorization.",
			"dispatch: In-session writers run on this machine. Tell them to run only the checks their change touches, push, and wait for the repository's CI to run full suites.",
			"dispatch: Writer default is long (Kimi K3). Use aperture/neuralwatt/glm-5.3 for small coding tasks; precise for auth, migrations, concurrency, or shared interfaces.",
			"dispatch: Never launch agent CLIs through bash to bypass rejected requests, depth limits, or tool restrictions; report the blocker.",
		],
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: "Clean feature repo root that worktree tasks branch from: the session cwd, a directory inside it, or a linked worktree of the session's repository (for example under ~/eden/.worktrees/). Must be on a feature branch. Defaults to the session cwd" })),
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
						"Sequential steps (max 8)",
				}),
			),
			aggregate: Type.Optional(
				Type.Boolean({
					description:
						"Merge parallel reports with the aggregator (default true)",
				}),
			),
			herdr: Type.Optional(
				Type.Boolean({
					description:
						"false disables Herdr viewer tabs",
				}),
			),
			persist: Type.Optional(
				Type.Boolean({
					description:
						"Keep worker sessions for resume",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						"Persisted sessionId to continue with task",
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

	registerFeaturePlanTool(pi);
	registerPrReviewTool(pi);
	registerCouncilTool(pi);
	registerDurableBatchTool(pi);

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
		if (params.resume) {
			if (!params.task || params.tasks || params.chain) {
				throw new Error(
					"dispatch: resume requires task and cannot be combined with tasks or chain.",
				);
			}
			const record = findWorkerSession(params.resume);
			if (!record)
				throw new Error(
					`dispatch: no persisted worker session with id ${params.resume}`,
				);
			mode = "resume";
			items = [{ agent: record.agent, task: params.task }];
		} else if (params.tasks && params.tasks.length > 0) {
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

		const unknown = [...new Set(items
			.map((i) => i.agent)
			.filter((name) => !byName.has(name)))];
		if (unknown.length > 0) {
			throw new Error(
				`dispatch: unknown agent(s): ${unknown.join(", ")}. Available agents:\n${agentRosterHelp(agents)}`,
			);
		}

		// Worktree tasks get their own git worktree — an explicit cwd there is
		// meaningless and conflicting. Checked BEFORE resolveSessionCwd so the
		// error the caller sees is the clearer of the two.
		const wantsWorktree = items.some((i) => i.worktree === true);
		if (items.some(i => i.agent === "writer" && i.worktree !== true)) {
			throw new Error("dispatch: writer requires tasks:[{agent:'writer', task, worktree:true}]; single/resume writers are not isolated");
		}
		if (params.target !== undefined && !wantsWorktree) throw new Error("dispatch: target requires worktree tasks");
		if (mode === "chain" && wantsWorktree) throw new Error("dispatch: chain worktrees are not supported; use tasks, then dispatch dependent work after authorized integration");
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
			items.map((item) => resolveSessionCwd(item.cwd, ctx, "dispatch")),
		);

		// ---- write tier setup (worktree tasks) ----
		const parentModel = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: undefined;
		let repoRoot: string | undefined;
		let runId: string | undefined;
		const randId = () => Math.random().toString(16).slice(2, 6);
		let target: Awaited<ReturnType<typeof resolveWorktreeTarget>> | undefined;
		const handoffs: WorktreeHandoff[] = [];
		if (wantsWorktree) {
			target = await resolveWorktreeTarget(await resolveWorktreeTargetDir(params.target, ctx));
			repoRoot = target.root;
			ensureExcluded(repoRoot);
			await pruneStale(repoRoot);
			runId = `run-${Date.now().toString(36)}-${randId()}`;
		}

		const planned = items.map((item) => ({
			...item,
			herdr: item.herdr ?? params.herdr,
		}));
		const willAggregate =
			mode !== "resume" &&
			(params.aggregate ?? (mode === "parallel" && items.length > 1)) &&
			byName.has("aggregator");
		if (willAggregate)
			planned.push({
				agent: "aggregator",
				task: "Distill worker reports",
				herdr: params.herdr,
			});
		const paneSession = new DispatchProgress(mode, planned, onUpdate);
		const emitProgress = () => paneSession.emit();
		try {
			await paneSession.open(ctx.cwd, signal);

			const taskModel = (item: TaskItem) =>
				item.model
					? {
							modelSpec: expandModelSpec(item.model)!,
							steerByQuota: isProfileTier(item.model),
							thinking: tierThinking(item.model),
						}
					: undefined;

			const runOne = async (
				agent: AgentConfig,
				task: string,
				cwd?: string,
				index?: number,
				resumeFile?: string,
				modelOverride?: { modelSpec: string; thinking?: string; steerByQuota?: boolean },
			) => {
				let result: WorkerResult;
				if (index !== undefined) paneSession.start(index);
				try {
					result = await runWorker(agent, task, {
						registry: ctx.modelRegistry,
						fallbackModel: ctx.model,
						cwd: cwd ?? ctx.cwd,
						signal,
						...(index !== undefined
							? paneSession.options(index)
							: { onBoundary: emitProgress }),
						persist: params.persist,
						resumeFile,
						modelSpec: modelOverride?.modelSpec,
						steerByQuota: modelOverride?.steerByQuota,
						thinking: modelOverride?.thinking,
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
						attempts: 0,
					};
				}
				if (index !== undefined) await paneSession.finish(index, result);
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
				const result = await runOne(
					agent,
					params.task,
					ctx.cwd,
					0,
					record.file,
				);
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
					content: [{ type: "text" as const, text: resumeText }],
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
					const result = await runOne(byName.get(item.agent)!, task, taskCwds[i], i, undefined, taskModel(item));
					results.push(result);
					previous = result.text;
				}
			} else {
				// Write tier: create all worktrees up front, sequentially — git
				// worktree creation mutates repo refs and races under concurrency.
				const worktrees: Array<{ path: string; branch: string } | undefined> =
					[];
				if (wantsWorktree) {
					try {
						for (let i = 0; i < items.length; i++) {
							if (items[i].worktree !== true) continue;
							worktrees[i] = await createWorktree(
								repoRoot!,
								runId!,
								`t${i + 1}-${randId()}`,
								target!.baseCommit,
							);
						}
					} catch (err) {
						// Never leak already-created worktrees on a setup failure.
						await Promise.allSettled(
							worktrees
								.filter(
									(w): w is { path: string; branch: string } => w !== undefined,
								)
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
				results = await mapWithConcurrency(items, MAX_CONCURRENCY, (item, i) => {
					const wt = worktrees[i];
					if (!wt) return runOne(byName.get(item.agent)!, item.task, taskCwds[i], i, undefined, taskModel(item));
					return paneSession.run(i, () => runWorkerProc(byName.get(item.agent)!, item.task, {
						cwd: wt.path, requireCleanWorktree: true, signal,
						model: parentModel, registry: ctx.modelRegistry,
						modelOverride: taskModel(item)?.modelSpec,
						steerByQuota: taskModel(item)?.steerByQuota,
						thinking: taskModel(item)?.thinking,
						...paneSession.options(i),
					}), signal);
				});
				for (let i = 0; i < worktrees.length; i++) {
					const wt = worktrees[i];
					if (!wt) continue;
					const handoff = await describeWorktree(repoRoot!, wt, {
						task: i + 1, agent: items[i].agent, status: results[i].status,
						base: target!.base, baseCommit: target!.baseCommit,
					});
					handoffs.push(handoff);
					if (results[i].status === "ok" && handoff.error) results[i] = { ...results[i], status: "error", error: handoff.error };
				}
			}

			// ---- fan-in / aggregation ----
			const doAggregate =
				params.aggregate ??
				(mode === "parallel" &&
					items.length > 1 &&
					results.some((r) => r.status === "ok"));
			let aggregated = false;
			let truncated = false;
			let content: string;

			if (
				doAggregate &&
				byName.has("aggregator") &&
				results.some((r) => r.status === "ok")
			) {
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
					willAggregate ? items.length : undefined,
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
						(results.length > ids.length
							? ` (+${results.length - ids.length} more)`
							: "") +
						` — resume with dispatch({ resume: "<sessionId>", task: "..." })]`;
				}
			}

			if (handoffs.length) content += "\n\n" + formatHandoff(repoRoot!, handoffs);

			const details: DispatchDetails = {
				mode,
				items: results,
				aggregated,
				truncated,
				total: items.length,
				...(handoffs.length ? { worktrees: handoffs } : {}),
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

			return {
				content: [{ type: "text" as const, text: content }],
				details,
				usage: sumUsages(results),
			};
		} finally {
			await paneSession.end();
		}
	}
}
