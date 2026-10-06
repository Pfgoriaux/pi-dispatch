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
	const failures = (result.failedAttempts ?? []).map(error => truncateText(error, 512));
	const output = truncateText([
		`## ${requested} — ${result.status} (actual: ${result.model ?? "not run"})`,
		result.status === "ok" ? result.text : `Unavailable: ${result.error ?? result.status}`,
		failures.length ? `Failed attempts:\n${failures.map(error => error.text).join("\n")}` : "",
	].filter(Boolean).join("\n\n"));
	return { text: output.text, truncated: [output, ...failures].some(part => part.truncated) };
}

export function registerCouncilTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "council",
		exposure: "model-only",
		label: "Council",
		description:
			"Get three independent, read-only opinions in parallel: Opus 5.5, GPT-6 Astra, and GLM 5.3 or Kimi K3. Returns labeled reports; the caller synthesizes them.",
		promptSnippet: "Consult three different models on a consequential decision",
		promptGuidelines: [
			"council: Use for requested multiple opinions or consequential competing options. Prefer one advisor for focused questions and feature_plan for implementation plans; skip routine work.",
			"council: Supply outcome, options, evidence, paths, constraints, and applicable instructions; advisors do not see this conversation.",
			"council: Summarize agreement, dissent, your recommendation, and the smallest next check. Name missing voices; fewer than three successful opinions is not a full council. Do not vote by majority or repeat without new evidence.",
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
				"Return at most 500 words using the advisor's Recommendation/Why/Risks/Check format. Include the strongest objection and uncertainty under Risks.",
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
