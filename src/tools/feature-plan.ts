/**
 * feature_plan — feature discovery & planning on top of the dispatch engine.
 *
 * Five-model diverse council: Opus 5.5, Astra, DeepSeek 4.1, Kimi 3, GLM 5.3
 * explore what a feature idea would entail. Each scout then receives the
 * conclusions from all other scouts in a council phase to refine their view.
 * Fable 5.1 drafts the final implementation plan from the council outputs.
 *
 * Model routing:
 * - Kimi 3: neuralwatt primary, steerByQuota handles neuralwatt/synthetic
 *   fallover automatically via withProviderFallbacks + quotaCandidates
 * - DeepSeek 4.1 Flash: quota-routed neuralwatt/synthetic, then Sonnet 5.5; simplified prompt
 *   focused on straightforward, non-overengineered solutions
 *
 * Context firewall unchanged: scouts' full transcripts never leave their
 * sessions; the parent only sees the final plan.
 */

import { Type } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { agentRosterHelp, discoverAgents } from "../agents.ts";
import { runWorker, truncateText } from "../worker.ts";
import type { DispatchDetails, WorkerResult } from "../types.ts";
import { DispatchProgress } from "../progress.ts";
import { renderDispatchResult } from "../render.ts";
import { ModelDiversity } from "../model-diversity.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Scout models — the five-model diverse council
// ─────────────────────────────────────────────────────────────────────────────

interface ScoutConfig {
	id: string;
	label: string;
	/** Model spec (can be dynamic for quota-routed models). */
	modelSpec: () => string;
	/** Thinking level for this scout. */
	thinking: string;
	/** Whether this scout uses a simplified prompt (DeepSeek). */
	simplifiedPrompt: boolean;
	/**
	 * Enable quota-based routing in runWorker. When true, withProviderFallbacks
	 * adds counterparts (e.g., kimi-k3 neuralwatt → synthetic) and quotaCandidates
	 * reorders by headroom. Used for models with known counterparts.
	 */
	steerByQuota: boolean;
}

function envModel(name: string): string | undefined {
	const v = process.env[name]?.trim();
	return v || undefined;
}

/** DeepSeek 4.1 Flash; fallbacks add the Synthetic peer, Sonnet 5.5, then Codex 6.1 Sol. */
function selectDeepSeekModel(): string {
	return envModel("DISPATCH_DEEPSEEK_MODEL") ?? "aperture/neuralwatt/deepseek-v4.1-flash";
}

const SCOUT_MODELS: ScoutConfig[] = [
	{
		id: "opus-5.5",
		label: "Opus 5.5",
		modelSpec: () => envModel("DISPATCH_OPUS55_MODEL") ?? "anthropic/claude-opus-5-5",
		thinking: "high",
		simplifiedPrompt: false,
		// Top-tier model; withProviderFallbacks adds Astra as counterpart,
		// steerByQuota reorders by headroom (prefers Codex on healthy tie).
		steerByQuota: true,
	},
	{
		id: "astra",
		label: "Astra",
		modelSpec: () => envModel("DISPATCH_ASTRA_MODEL") ?? "openai-codex/gpt-6-astra",
		thinking: "high",
		simplifiedPrompt: false,
		// Top-tier model; withProviderFallbacks adds Opus as counterpart.
		steerByQuota: true,
	},
	{
		id: "deepseek-4.1",
		label: "DeepSeek 4.1",
		modelSpec: selectDeepSeekModel,
		thinking: "high",
		simplifiedPrompt: true, // Uses straightforward, non-overengineered prompt
		// withProviderFallbacks adds the synthetic counterpart; steer by headroom.
		steerByQuota: true,
	},
	{
		id: "kimi-3",
		label: "Kimi 3",
		// Use neuralwatt primary; withProviderFallbacks adds synthetic counterpart,
		// steerByQuota reorders by headroom (prefers synthetic on healthy tie).
		modelSpec: () => envModel("DISPATCH_KIMI3_MODEL") ?? "aperture/neuralwatt/kimi-k3",
		thinking: "high",
		simplifiedPrompt: false,
		steerByQuota: true,
	},
	{
		id: "glm-5.3",
		label: "GLM 5.3",
		modelSpec: () => envModel("DISPATCH_GLM53_MODEL") ?? "aperture/neuralwatt/glm-5.3",
		thinking: "high",
		simplifiedPrompt: false,
		// No synthetic counterpart for GLM 5.3.
		steerByQuota: false,
	},
];

/** Fable 5.1 — the final planner that drafts the implementation plan. */
function getFable51Model(): string {
	return envModel("DISPATCH_FABLE51_MODEL") ?? "anthropic/claude-fable-5-1";
}

// ─────────────────────────────────────────────────────────────────────────────
// Scout lens sections — what each scout explores
// ─────────────────────────────────────────────────────────────────────────────

const SCOUT_LENS_SECTIONS = [
	"Where this feature would live (modules/files, with paths)",
	"What already exists — patterns & infrastructure to reuse or respect",
	"Technical risks & integration points (ordering, concurrency, schema/compat)",
	"Migration / backward-compat concerns (if any)",
	"Technical unknowns that need a spike first",
];

// ─────────────────────────────────────────────────────────────────────────────
// Task generators
// ─────────────────────────────────────────────────────────────────────────────

/** Standard scout task — comprehensive architecture exploration. */
function scoutTask(c: {
	cwd: string;
	idea: string;
	focus: string;
	scoutConfig: ScoutConfig;
}): string {
	const lines = [
		`Discover what implementing this feature would entail, from the architecture & technical-risk angle.`,
		"Read applicable AGENTS.md instructions first; do not modify the repository.",
		`Repository: ${c.cwd}`,
		"",
		"FEATURE IDEA:",
		c.idea,
	];
	if (c.focus.trim()) {
		lines.push(
			"",
			`FOCUS / scope hint from the user: "${c.focus}". Explore there first.`,
		);
	}
	lines.push(
		"",
		"START by orienting with your ls/find/grep tools, then OPEN the relevant files. " +
			"Never assert a constraint, pattern, or risk you have not verified in the actual code.",
		`You are scout "${c.scoutConfig.label}" — cover THESE sections:`,
		"",
		...SCOUT_LENS_SECTIONS.map((s) => `## ${s}`),
		"## Questions for the human (max 5, only ones that change scope or feasibility)",
		"",
		"Rules: be concrete and cite file paths. Keep the report under ~200 lines. " +
			"If something is unknown, say unknown — do not fabricate.",
	);
	return lines.join("\n");
}

/** Simplified scout task for DeepSeek 4.1 — focus on simplest, most straightforward solution. */
function simplifiedScoutTask(c: {
	cwd: string;
	idea: string;
	focus: string;
	scoutConfig: ScoutConfig;
}): string {
	const lines = [
		`Find the SIMPLEST way to implement this feature. Avoid overengineering.`,
		"Read applicable AGENTS.md instructions first; do not modify the repository.",
		`Repository: ${c.cwd}`,
		"",
		"FEATURE IDEA:",
		c.idea,
	];
	if (c.focus.trim()) {
		lines.push("", `FOCUS: "${c.focus}".`);
	}
	lines.push(
		"",
		`You are scout "${c.scoutConfig.label}" — your job is to find the MOST STRAIGHTFORWARD fix.`,
		"",
		"Principles:",
		"- Prefer the smallest change that solves the problem",
		"- Reuse existing code and patterns — do not reinvent",
		"- If something works, do not refactor it",
		"- Avoid new abstractions unless absolutely necessary",
		"- One file is better than two; no file is better than one",
		"",
		"Report structure:",
		"## Simplest solution (one paragraph)",
		"## Files to touch (paths only, minimal list)",
		"## What NOT to do (common overengineering traps)",
		"## Open questions (max 3)",
		"",
		"Rules: cite file paths. Keep the report under ~100 lines. Be terse.",
	);
	return lines.join("\n");
}

/** Council task — each scout reconsiders their findings after seeing others' conclusions. */
function councilTask(c: {
	cwd: string;
	idea: string;
	scoutConfig: ScoutConfig;
	ownReport: string;
	otherReports: { label: string; conclusion: string }[];
}): string {
	const lines = [
		`Review your initial findings in light of the other scouts' conclusions.`,
		`Repository: ${c.cwd}`,
		"",
		"FEATURE IDEA:",
		c.idea,
		"",
		"YOUR INITIAL REPORT:",
		c.ownReport,
		"",
		"OTHER SCOUTS' CONCLUSIONS:",
		...c.otherReports.map((r) => `### ${r.label}\n${r.conclusion}`),
		"",
		`You are "${c.scoutConfig.label}" in the council phase.`,
		"",
		"Instructions:",
		"1. Consider insights from other scouts you may have missed",
		"2. Note disagreements you stand by (and why)",
		"3. Revise your conclusions where others make valid points",
		"4. Keep what you got right",
		"",
		"Output your FINAL CONCLUSION with this structure:",
		"## Key insights (what matters most)",
		"## Revised recommendations (if any changes)",
		"## Points of agreement with others",
		"## Points where I disagree (with rationale)",
		"## Final risk assessment",
		"",
		"Keep it under ~150 lines. Be concrete.",
	];
	return lines.join("\n");
}

/** Fable 5.1 planner task — draft the implementation plan from council outputs. */
function fablePlannerTask(c: {
	cwd: string;
	idea: string;
	councilOutputs: { label: string; conclusion: string }[];
}): string {
	const lines = [
		"Draft the implementation plan for this feature.",
		"Read applicable AGENTS.md instructions first.",
		`Repository: ${c.cwd}`,
		"",
		"FEATURE IDEA:",
		c.idea,
		"",
		`COUNCIL CONCLUSIONS (${c.councilOutputs.length} scouts, each having seen the others' initial findings):`,
		...c.councilOutputs.map((r) => `### ${r.label}\n${r.conclusion}`),
		"",
		"Your task:",
		"1. Synthesize the council's conclusions into a coherent plan",
		"2. Resolve remaining disagreements with explicit rationale",
		"3. Verify any critical claims in the actual code if uncertain",
		"4. Prioritize the simplest viable approach",
		"",
		"Return the plan with this structure (Markdown):",
		"",
		"# Feature plan: <short title>",
		"## Goal & why",
		"## Recommended scope (MVP first, then phases)",
		"## Where the code goes (modules/files, paths)",
		"## Architecture & integration decisions",
		"## Work breakdown (phased tasks, S/M/L)",
		"## Test strategy",
		"## Council disagreements (and how resolved)",
		"## Open questions for the human",
	];
	return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerFeaturePlanTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "feature_plan",
		label: "Feature Discovery & Plan (5-Scout Council)",
		description:
			"Explore what implementing a feature idea would entail, using 5 parallel scout agents " +
			"(Opus 5.5, Astra, DeepSeek 4.1, Kimi 3, GLM 5.3) with a council phase where each scout " +
			"refines their view after seeing others' conclusions. Fable 5.1 drafts the final plan. " +
			"Use BEFORE coding, when the user wants to discover, scope, or plan a feature. " +
			"Read-only: never modifies the repository.",
		promptSnippet:
			"Discover & plan a feature: 5 diverse scouts (Opus 5.5, Astra, DeepSeek 4.1, Kimi 3, GLM 5.3) + council phase + Fable 5.1 planner, read-only",
		promptGuidelines: [
			"feature_plan: Use BEFORE coding, when the user wants to discover, scope, or plan a feature. Read-only, no Herdr needed.",
			"feature_plan: Do NOT use for syntax, lookups, or bugs with a known root cause — scout overhead is wasted there.",
		],
		parameters: Type.Object({
			herdr: Type.Optional(
				Type.Boolean({
					description: "Show worker viewer tabs inside Herdr (default true).",
				}),
			),
			idea: Type.String({
				description:
					"The feature idea to discover & plan, in the user's own words (can be rough/long)",
			}),
			focus: Type.Optional(
				Type.String({
					description:
						"Optional scope hint: a directory, module, or keyword to orient the exploration toward (e.g. 'packages/api')",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const started = Date.now();
			const { byName, agents } = discoverAgents(ctx);
			const scout = byName.get("scout");
			const planner = byName.get("planner");
			const missing = [!scout && "scout", !planner && "planner"].filter(
				Boolean,
			);
			if (missing.length > 0) {
				throw new Error(
					`feature_plan: missing bundled agent(s): ${missing.join(", ")}. Available agents:\n${agentRosterHelp(agents)}`,
				);
			}

			// Build progress tracker for all phases:
			// Phase 1: 5 scouts (indices 0-4)
			// Phase 2: 5 council reviews (indices 5-9)
			// Phase 3: 1 Fable planner (index 10)
			const progressItems = [
				...SCOUT_MODELS.map((s) => ({
					agent: "scout",
					task: `Scout: ${s.label}`,
					herdr: params.herdr,
				})),
				...SCOUT_MODELS.map((s) => ({
					agent: "scout",
					task: `Council: ${s.label}`,
					herdr: params.herdr,
				})),
				{ agent: "planner", task: "Fable 5.1: Draft plan", herdr: params.herdr },
			];

			const progress = new DispatchProgress(
				"chain",
				progressItems,
				onUpdate,
			);

			try {
				await progress.open(ctx.cwd, signal);

				const scoutCtx = {
					cwd: ctx.cwd,
					idea: params.idea,
					focus: params.focus?.trim() ?? "",
				};

				// ─────────────────────────────────────────────────────────────────
				// Phase 1: Run 5 scouts in parallel
				// ─────────────────────────────────────────────────────────────────

				const scoutModels = new ModelDiversity();
				const runScout = async (
					index: number,
					scoutConfig: ScoutConfig,
				): Promise<WorkerResult> => {
					const task = scoutConfig.simplifiedPrompt
						? simplifiedScoutTask({ ...scoutCtx, scoutConfig })
						: scoutTask({ ...scoutCtx, scoutConfig });

					// Static specs; steerByQuota routes counterparts where configured.
					const modelSpec = scoutConfig.modelSpec();

					return progress.run(
						index,
						() =>
							runWorker(scout!, task, {
								registry: ctx.modelRegistry,
								fallbackModel: ctx.model,
								cwd: ctx.cwd,
								signal,
								modelSpec,
								steerByQuota: scoutConfig.steerByQuota,
								claimModel: scoutModels.worker(),
								thinking: scoutConfig.thinking,
								...progress.options(index),
							}),
						signal,
					);
				};

				const scoutResults = await Promise.all(
					SCOUT_MODELS.map((s, i) => runScout(i, s)),
				);

				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Aborted during scouting phase." }],
						details: undefined,
						usage: sumUsage(scoutResults),
					};
				}

				const okScouts = scoutResults.filter((r) => r.status === "ok");
				if (okScouts.length < 2) {
					const errors = scoutResults
						.map(
							(r, i) =>
								`- ${SCOUT_MODELS[i].label}: ${r.status === "ok" ? "ok" : truncateText(r.error ?? "failed").text}`,
						)
						.join("\n");
					return {
						content: [
							{
								type: "text",
								text: `feature_plan: too few scouts succeeded (${okScouts.length}/5).\n${errors}`,
							},
						],
						details: {
							mode: "parallel",
							items: scoutResults,
							aggregated: false,
							truncated: false,
						} satisfies DispatchDetails,
						usage: sumUsage(scoutResults),
					};
				}

				// ─────────────────────────────────────────────────────────────────
				// Phase 2: Council — each scout sees others' conclusions
				// ─────────────────────────────────────────────────────────────────

				const councilModels = new ModelDiversity();
				const runCouncil = async (
					scoutIndex: number,
					scoutConfig: ScoutConfig,
					ownResult: WorkerResult,
				): Promise<WorkerResult> => {
					// Skip council for failed scouts
					if (ownResult.status !== "ok") {
						return progress.run(5 + scoutIndex, async () => ({
							agent: scout!.name,
							task: `Council: ${scoutConfig.label}`,
							status: "error",
							text: "",
							error: `Skipped: initial scout failed (${ownResult.error})`,
							attempts: 0,
							ms: 0,
						}), signal);
					}

					const otherReports = scoutResults
						.map((r, i) => ({
							label: `${SCOUT_MODELS[i].label} [actual model: ${r.model ?? "unavailable"}]`,
							conclusion: r.status === "ok"
								? truncateText(r.text || "(no output)", 2000).text
								: `(FAILED: ${r.error})`,
							isOwn: i === scoutIndex,
						}))
						.filter((r) => !r.isOwn);

					const task = councilTask({
						cwd: ctx.cwd,
						idea: params.idea,
						scoutConfig,
						ownReport: truncateText(ownResult.text || "(no output)", 3000).text,
						otherReports,
					});

					const councilIndex = 5 + scoutIndex; // Indices 5-9
					const modelSpec = scoutConfig.modelSpec();

					return progress.run(
						councilIndex,
						() =>
							runWorker(scout!, task, {
								registry: ctx.modelRegistry,
								fallbackModel: ctx.model,
								cwd: ctx.cwd,
								signal,
								modelSpec,
								steerByQuota: scoutConfig.steerByQuota,
								claimModel: councilModels.worker(),
								thinking: scoutConfig.thinking,
								...progress.options(councilIndex),
							}),
						signal,
					);
				};

				const councilResults = await Promise.all(
					SCOUT_MODELS.map((s, i) => runCouncil(i, s, scoutResults[i])),
				);

				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Aborted during council phase." }],
						details: undefined,
						usage: sumUsage([...scoutResults, ...councilResults]),
					};
				}

				// ─────────────────────────────────────────────────────────────────
				// Phase 3: Fable 5.1 drafts the final plan
				// ─────────────────────────────────────────────────────────────────

				const councilOutputs = councilResults.map((r, i) => ({
					label: `${SCOUT_MODELS[i].label} [actual model: ${(r.status === "ok" ? r : scoutResults[i]).model ?? "unavailable"}]`,
					conclusion:
						r.status === "ok"
							? truncateText(r.text || "(no output)", 2500).text
							: // Fall back to initial scout report if council failed
								scoutResults[i].status === "ok"
								? `(Council failed, initial report): ${truncateText(scoutResults[i].text || "(no output)", 2000).text}`
								: `(Both phases failed: ${r.error})`,
				})).filter((_, i) => scoutResults[i].status === "ok");

				const fablePlannerResult = await progress.run(
					10, // Index 10
					() =>
						runWorker(
							planner!,
							fablePlannerTask({
								cwd: ctx.cwd,
								idea: params.idea,
								councilOutputs,
							}),
							{
								registry: ctx.modelRegistry,
								fallbackModel: ctx.model,
								cwd: ctx.cwd,
								signal,
								modelSpec: getFable51Model(),
								steerByQuota: false, // Fable has no known counterpart
								thinking: "high",
								...progress.options(10),
							},
						),
					signal,
				);

				const allResults: WorkerResult[] = [
					...scoutResults,
					...councilResults,
					fablePlannerResult,
				];

				const content =
					fablePlannerResult.status === "ok"
						? truncateText(fablePlannerResult.text).text
						: // Fallback: show council conclusions if Fable failed
							councilOutputs
								.map(
									(c) =>
										`## ${c.label} (council conclusion)\n${c.conclusion}`,
								)
								.join("\n\n") +
							`\n\nfeature_plan: Fable 5.1 planner failed — raw council conclusions shown above. ${truncateText(fablePlannerResult.error ?? "").text}`;

				const usage = sumUsage(allResults);
				return {
					content: [{ type: "text", text: content }],
					details: {
						mode: "chain",
						items: allResults,
						aggregated: fablePlannerResult.status === "ok",
						truncated: false,
						total: allResults.length,
					} satisfies DispatchDetails,
					usage: usage ?? undefined,
				};
			} finally {
				await progress.end();
			}
		},
		renderResult: renderDispatchResult as never,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage utilities
// ─────────────────────────────────────────────────────────────────────────────

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
