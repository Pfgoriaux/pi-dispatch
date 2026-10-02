/**
 * feature_plan — feature discovery & planning on top of the dispatch engine.
 *
 * Flow (sequential, each step sees the previous outputs):
 *   1. Architect (Astra) discovers the code and drafts a design.
 *   2. Pre-mortem (DeepSeek 4.1 Flash, cheap): "if this breaks in 3 months, why?"
 *   3. Challenger (Opus 5.5) reviews the draft, informed by the pre-mortem.
 *   4. The same architect resolves the challenge into worker-ready task
 *      contracts and lists only product decisions for the human.
 *
 * Architect and challenger stay on OpenAI/Anthropic: their fallbacks are the
 * cross-provider peer, then Sol 6.1. A shared ModelDiversity pool keeps the
 * challenger off the architect's model. Execution is not part of this tool;
 * each task names its executor model for writer dispatch.
 *
 * Context firewall unchanged: worker transcripts never leave their sessions;
 * the parent only sees the final plan.
 */

import { Type } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentRosterHelp, discoverAgents } from "../agents.ts";
import { runWorker, truncateText } from "../worker.ts";
import type { AgentConfig, DispatchDetails, WorkerResult } from "../types.ts";
import { DispatchProgress } from "../progress.ts";
import { renderDispatchResult } from "../render.ts";
import { ModelDiversity } from "../model-diversity.ts";
import {
	architectDraftTask,
	architectFinalTask,
	challengerTask,
	preMortemTask,
	type PlanContext,
} from "./feature-plan-prompts.ts";

function envModel(name: string): string | undefined {
	const v = process.env[name]?.trim();
	return v || undefined;
}

const architectModel = () => envModel("DISPATCH_ARCHITECT_MODEL") ?? "openai-codex/gpt-6-astra";
const challengerModel = () => envModel("DISPATCH_CHALLENGER_MODEL") ?? "anthropic/claude-opus-5-5";
const preMortemModel = () => envModel("DISPATCH_PREMORTEM_MODEL") ?? "aperture/neuralwatt/deepseek-v4.1-flash";

const STEPS = [
	{ agent: "planner", task: "Architect: draft design" },
	{ agent: "scout", task: "Pre-mortem: 3-month failure" },
	{ agent: "scout", task: "Challenger: review design" },
	{ agent: "planner", task: "Architect: final plan" },
];

interface StepModel {
	spec: string;
	/** Reorder exact provider peers by quota headroom (DeepSeek NeuralWatt/Synthetic). */
	steerByQuota?: boolean;
	claimModel?: (spec: string) => boolean;
}

/** Model-visible text of a step, or a marker the next step can reason about. */
function outputOf(r: WorkerResult): string {
	if (r.status !== "ok") return `(unavailable: ${truncateText(r.error ?? r.status).text})`;
	return truncateText(r.text || "(no output)").text;
}

function modelLine(results: WorkerResult[]): string {
	const roles = ["architect", "pre-mortem", "challenger", "final"];
	return results.map((r, i) => `${roles[i]}: ${r.model ?? "unavailable"}`).join(", ");
}

/** Shown when the final step fails: the material the architect would have resolved. */
function fallbackPlan(results: WorkerResult[]): string {
	const [draft, preMortem, challenge, final] = results;
	return [
		"## Architect draft", outputOf(draft),
		"## Pre-mortem", outputOf(preMortem),
		"## Design challenge", outputOf(challenge),
		`feature_plan: final architect step failed; unresolved inputs shown above. ${truncateText(final.error ?? "").text}`,
	].join("\n\n");
}

export function registerFeaturePlanTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "feature_plan",
		label: "Feature Plan (Architect + Challenger)",
		description:
			"Plan a feature before coding. An OpenAI architect (Astra) discovers the code and drafts a design, " +
			"a cheap DeepSeek 4.1 pre-mortem asks why it would break in 3 months, an Anthropic challenger (Opus 5.5) " +
			"reviews the design, and the architect returns task contracts for GLM/Kimi writers plus product decisions only. " +
			"Read-only: never modifies the repository.",
		promptSnippet:
			"Plan a feature: Astra architect, DeepSeek pre-mortem, Opus challenger, worker-ready task contracts, read-only",
		promptGuidelines: [
			"feature_plan: Use BEFORE coding, when the user wants to discover, scope, or plan a feature. Read-only, no Herdr needed.",
			"feature_plan: Do NOT use for syntax, lookups, small fixes, or bugs with a known root cause.",
			"feature_plan: Show the plan and its 'Decisions for you' to the user before implementing. To execute an approved plan, dispatch each task's contract verbatim to writer with the task's Executor as model; run dependent tasks in order.",
		],
		parameters: Type.Object({
			herdr: Type.Optional(
				Type.Boolean({ description: "Show worker viewer tabs inside Herdr (default true)." }),
			),
			idea: Type.String({
				description: "The feature idea to discover & plan, in the user's own words (can be rough/long)",
			}),
			focus: Type.Optional(
				Type.String({
					description:
						"Optional scope hint: a directory, module, or keyword to orient the exploration toward (e.g. 'packages/api')",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { byName, agents } = discoverAgents(ctx);
			const scout = byName.get("scout");
			const planner = byName.get("planner");
			if (!scout || !planner) {
				const missing = [!scout && "scout", !planner && "planner"].filter(Boolean);
				throw new Error(
					`feature_plan: missing bundled agent(s): ${missing.join(", ")}. Available agents:\n${agentRosterHelp(agents)}`,
				);
			}

			const progress = new DispatchProgress(
				"chain",
				STEPS.map((s) => ({ ...s, herdr: params.herdr })),
				onUpdate,
			);
			const results: WorkerResult[] = [];
			const step = async (agent: AgentConfig, task: string, model: StepModel) => {
				const index = results.length;
				const result = await progress.run(
					index,
					() =>
						runWorker(agent, task, {
							registry: ctx.modelRegistry,
							fallbackModel: ctx.model,
							cwd: ctx.cwd,
							signal,
							modelSpec: model.spec,
							steerByQuota: model.steerByQuota ?? false,
							claimModel: model.claimModel,
							thinking: "high",
							...progress.options(index),
						}),
					signal,
				);
				results.push(result);
				return result;
			};
			const finish = (text: string, aggregated: boolean) => ({
				content: [{ type: "text" as const, text }],
				details: {
					mode: "chain",
					items: results,
					aggregated,
					truncated: false,
					total: STEPS.length,
				} satisfies DispatchDetails,
				usage: sumUsage(results),
			});

			try {
				await progress.open(ctx.cwd, signal);
				const c: PlanContext = { cwd: ctx.cwd, idea: params.idea, focus: params.focus?.trim() ?? "" };
				// Architect and challenger share one pool so fallbacks never give both the same model.
				const designers = new ModelDiversity();

				const draft = await step(planner, architectDraftTask(c), {
					spec: architectModel(),
					claimModel: designers.worker(),
				});
				if (draft.status !== "ok") {
					return finish(`feature_plan: architect draft failed. ${outputOf(draft)}`, false);
				}
				const draftText = outputOf(draft);

				const preMortem = await step(scout, preMortemTask(c, draftText), {
					spec: preMortemModel(),
					steerByQuota: true,
				});
				const challenge = await step(scout, challengerTask(c, draftText, outputOf(preMortem)), {
					spec: challengerModel(),
					claimModel: designers.worker(),
				});
				if (signal?.aborted) return finish("Aborted before the final plan.", false);

				// Pin the model that wrote the draft so the same architect owns the final plan.
				const final = await step(
					planner,
					architectFinalTask(c, draftText, outputOf(preMortem), outputOf(challenge)),
					{ spec: draft.model ?? architectModel() },
				);
				const body = final.status === "ok" ? truncateText(final.text).text : fallbackPlan(results);
				return finish(`${body}\n\n_Models: ${modelLine(results)}_`, final.status === "ok");
			} finally {
				await progress.end();
			}
		},
		renderResult: renderDispatchResult as never,
	});
}

/** Sum two Usage objects; missing values count as 0. */
function sumTwo(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
		cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: (a.cost.cacheRead ?? 0) + (b.cost.cacheRead ?? 0),
			cacheWrite: (a.cost.cacheWrite ?? 0) + (b.cost.cacheWrite ?? 0),
			total: a.cost.total + b.cost.total,
		},
	};
}

/** Sum usage across finished workers (undefined until one reports usage). */
function sumUsage(results: WorkerResult[]): Usage | undefined {
	let acc: Usage | undefined;
	for (const r of results) {
		if (r.usage) acc = acc ? sumTwo(acc, r.usage) : r.usage;
	}
	return acc;
}
