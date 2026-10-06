import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents.ts";
import { DispatchProgress } from "../progress.ts";
import { renderDispatchResult } from "../render.ts";
import type { DispatchDetails, WorkerResult } from "../types.ts";
import { runWorker, sumWorkerUsage, truncateText } from "../worker.ts";

const OPUS = "anthropic/claude-opus-5-5";
const ASTRA = "openai-codex/gpt-6-astra";
const THIRD = {
	"glm-5.3": ["aperture/neuralwatt/glm-5.3", "synthetic/hf:zai-org/GLM-5.3"],
	"kimi-k3": ["aperture/neuralwatt/kimi-k3", "aperture/synthetic/hf:moonshotai/Kimi-K3"],
} as const;

function report(result: WorkerResult, requested: string) {
	const failures = (result.failedAttempts ?? []).join("\n");
	return truncateText([
		`## ${requested} — ${result.status} (actual: ${result.model ?? "not run"})`,
		failures ? `Failed attempts:\n${failures}` : "",
		result.status === "ok" ? result.text : `Unavailable: ${result.error ?? result.status}`,
	].filter(Boolean).join("\n\n"));
}

export function registerCouncilTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "council",
		label: "Council",
		description:
			"Get three independent, read-only opinions in parallel: Opus 5.5, GPT-6 Astra, and GLM 5.3 or Kimi K3. Returns labeled reports; the caller synthesizes them.",
		promptSnippet: "Consult three different models on a consequential decision",
		promptGuidelines: [
			"council: Use when the user asks for a council or several opinions, or a consequential decision has competing options that merit independent judgment. Prefer one advisor for a focused second opinion; use feature_plan for implementation planning. Skip routine tasks.",
			"council: Supply a self-contained question and context: outcome, options, evidence, relevant paths, constraints, and applicable instructions. Workers cannot see this conversation.",
			"council: Synthesize the reports into agreement, disagreement, your recommendation, and the smallest next check. Preserve dissent and missing voices; do not decide by majority vote or call fewer than three successful opinions a full council. Do not repeat without new evidence.",
		],
		parameters: Type.Object({
			question: Type.String({ minLength: 1, description: "The decision or question to assess" }),
			context: Type.Optional(Type.String({ description: "Evidence, options, paths, constraints, and applicable instructions" })),
			third: Type.Optional(Type.Union([Type.Literal("glm-5.3"), Type.Literal("kimi-k3")], {
				description: "Third model; defaults to glm-5.3",
			})),
			herdr: Type.Optional(Type.Boolean({ description: "false disables Herdr viewer tabs" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!params.question.trim()) throw new Error("council: question must not be blank");
			const advisor = discoverAgents(ctx).byName.get("advisor");
			if (!advisor) throw new Error("council: advisor agent is unavailable");
			// Custom role overrides cannot grant council workers local write/shell tools.
			const reader = { ...advisor, tools: ["read", "grep", "find", "ls"] };
			const third = THIRD[params.third ?? "glm-5.3"];
			const seats = [[OPUS], [ASTRA], third];
			const task = [
				"Give an independent opinion on this decision. You cannot see the other opinions.",
				"Read-only: do not edit files or execute shell commands. Inspect only relevant evidence.",
				"Return at most 500 words: recommendation, evidence, strongest objection, uncertainty, and smallest next check.",
				"Assess the options fairly; do not endorse a preferred answer by default. Do not produce implementation task contracts.",
				`Question:\n${params.question}`,
				`Context:\n${params.context ?? "(none supplied)"}`,
			].join("\n\n");
			const progress = new DispatchProgress("parallel", seats.map(([model]) => ({
				agent: "advisor", task: `Council: ${model}`, herdr: params.herdr,
			})), onUpdate);
			try {
				await progress.open(ctx.cwd, signal);
				const results = await Promise.all(seats.map((routes, index) => progress.run(index, () =>
					runWorker(reader, task, {
						registry: ctx.modelRegistry,
						fallbackModel: ctx.model,
						cwd: ctx.cwd,
						signal,
						modelSpec: routes[0],
						fallbackModels: routes.slice(1),
						allowedModels: routes,
						steerByQuota: false,
						thinking: "high",
						...progress.options(index),
					}), signal)));
				const successful = results.filter(result => result.status === "ok").length;
				const reports = results.map((result, index) => report(result, seats[index][0]));
				const heading = signal?.aborted ? "Council aborted" : `Council: ${successful}/3 opinions available`;
				return {
					content: [
						{ type: "text" as const, text: `${heading}. Synthesize the labeled reports; preserve disagreements and unavailable voices.` },
						...reports.map(({ text }) => ({ type: "text" as const, text })),
					],
					isError: successful === 0 || signal?.aborted === true,
					details: {
						mode: "parallel", items: results, aggregated: false,
						truncated: reports.some(result => result.truncated), total: 3,
					} satisfies DispatchDetails,
					usage: sumWorkerUsage(results),
				};
			} finally {
				await progress.end();
			}
		},
		renderResult: renderDispatchResult as never,
	});
}
