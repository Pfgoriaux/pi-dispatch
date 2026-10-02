/**
 * feature_plan — architect draft → cheap pre-mortem → challenger → architect final plan.
 * Architect and challenger share one ModelDiversity pool, and the final step excludes
 * the challenger's model, so fallbacks never merge the two roles.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentRosterHelp, discoverAgents } from "../agents.ts";
import { runWorker, sumWorkerUsage, truncateText } from "../worker.ts";
import type { AgentConfig, DispatchDetails, WorkerResult } from "../types.ts";
import { DispatchProgress } from "../progress.ts";
import { renderDispatchResult } from "../render.ts";
import { ModelDiversity } from "../model-diversity.ts";
import { WORKFLOW_FALLBACK_MODELS } from "../profiles.ts";
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
	steerByQuota?: boolean;
	claimModel?: (spec: string) => boolean;
	excludeModels?: string[];
}

/** Model-visible text of a step, or a marker the next step can reason about. */
function outputOf(r: WorkerResult): string {
	if (r.status !== "ok") return `(unavailable: ${truncateText(r.error ?? r.status).text})`;
	return truncateText(r.text || "(no output)").text;
}

/** Shown when the final step fails: the material the architect would have resolved. */
function fallbackPlan(results: WorkerResult[]): string {
	const [draft, preMortem, challenge, final] = results;
	return [
		"## Architect draft", outputOf(draft),
		"## Pre-mortem", outputOf(preMortem),
		"## Design challenge", outputOf(challenge),
		`feature_plan: final architect step did not finish; unresolved inputs shown above. ${truncateText(final.error ?? final.status).text}`,
	].join("\n\n");
}

export function registerFeaturePlanTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "feature_plan",
		label: "Feature Plan (Architect + Challenger)",
		description:
			"Read-only feature planning: architect draft, pre-mortem, independent challenge, then a plan of product decisions and task contracts.",
		promptSnippet:
			"Plan a feature (read-only)",
		promptGuidelines: [
			"feature_plan: Use when the user asks to plan or scope a feature. Not for small changes or bugs.",
			"feature_plan: Show the plan and its decisions to the user. Once approved, execute with dispatch tasks:[{agent:'writer', worktree:true, model:<Executor>, task:<contract verbatim>}]; independent tasks in one call, dependent tasks in later calls. Never execute a truncated plan.",
		],
		parameters: Type.Object({
			herdr: Type.Optional(
				Type.Boolean({
					description: "false disables Herdr viewer tabs",
				}),
			),
			idea: Type.String({
				description:
					"The feature idea in the user's words",
			}),
			focus: Type.Optional(
				Type.String({
					description:
						"Directory, module, or keyword to explore first",
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
							excludeModels: model.excludeModels,
							fallbackModels: WORKFLOW_FALLBACK_MODELS,
							thinking: "high",
							...progress.options(index),
						}),
					signal,
				);
				results.push(result);
				return result;
			};
			const finish = (text: string, aggregated: boolean, truncated = false) => ({
				content: [{ type: "text" as const, text }],
				details: {
					mode: "chain",
					items: results,
					aggregated,
					truncated,
					total: STEPS.length,
				} satisfies DispatchDetails,
				usage: sumWorkerUsage(results),
			});

			try {
				await progress.open(ctx.cwd, signal);
				const c: PlanContext = { cwd: ctx.cwd, idea: params.idea, focus: params.focus?.trim() ?? "" };
				const designers = new ModelDiversity();

				const draft = await step(planner, architectDraftTask(c), {
					spec: architectModel(),
					claimModel: designers.worker(),
				});
				if (signal?.aborted) return finish("feature_plan: aborted during the architect draft.", false);
				if (draft.status !== "ok") {
					return finish(`feature_plan: architect draft failed. ${truncateText(draft.error ?? "").text}`, false);
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
				if (signal?.aborted) return finish("feature_plan: aborted before the final plan.", false);

				// Same model as the draft; never the challenger's, even on fallback.
				const final = await step(
					planner,
					architectFinalTask(c, draftText, outputOf(preMortem), outputOf(challenge)),
					{ spec: draft.model ?? architectModel(), excludeModels: challenge.model ? [challenge.model] : undefined },
				);
				if (final.status !== "ok") return finish(fallbackPlan(results), false);
				const plan = truncateText(final.text);
				return finish(plan.text, true, plan.truncated);
			} finally {
				await progress.end();
			}
		},
		renderResult: renderDispatchResult as never,
	});
}
