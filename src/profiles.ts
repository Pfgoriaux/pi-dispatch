/**
 * Model-tier routing for agent spawning.
 *
 * Agents request a tier by name in their frontmatter (`model: cheap`); this
 * module expands it to a concrete `provider/id` spec without choosing thinking effort.
 * "inherit" and explicit provider/id specs keep their existing meaning.
 *
 * TIER SELECTION GUIDE:
 *
 *   cheap    — Simple lookups, grep-and-report, boilerplate generation.
 *              Fast, low-cost. Use for scouts doing file discovery or
 *              straightforward extraction tasks.
 *
 *   balanced — Standard reviews, synthesis, general-purpose work.
 *              Good cost/quality ratio. Sonnet 5.5 / Sol 6.1 with
 *              quota-aware routing between them.
 *
 *   precise  — Security review, architecture decisions, complex features,
 *              production-critical code. Top-tier models (Opus 5.5 / Astra)
 *              with quota-aware routing between them.
 *
 *   long     — Frontend and UI, design, data visualization, image inputs,
 *              end-to-end feature builds. Kimi K3. The writer defaults to
 *              GLM_MODEL, which dispatch gates onto Opus/Astra (see gateGlm).
 *
 * Tiers choose model strength, not thinking effort. Pick a tier by how hard
 * a task is, not by who does it. Cross-check scouting and duplicate code review need
 * deliberately different fixed models — a tier is shared, so two workers
 * on the same tier are correlated.
 *
 * Every tier model is overridable with `DISPATCH_PROFILE_<TIER>_MODEL`.
 */

export type ProfileTier = "cheap" | "balanced" | "precise" | "long";

export interface ModelProfile {
	/** Concrete model spec ("provider/id"). */
	model: string;
}

function envModel(name: string): string | undefined {
	const v = process.env[name]?.trim();
	return v || undefined;
}

/** Literal defaults; Hetzner drafting guidance must not inherit profile overrides. */
export const KIMI_MODEL = "aperture/neuralwatt/kimi-k3";
export const GLM_MODEL = "aperture/neuralwatt/glm-5.3";

export const PROFILES: Record<ProfileTier, ModelProfile> = {
	// CHEAP: Simple tasks, file discovery, grep-and-report, boilerplate.
	// DeepSeek V4.1 Flash (Aperture has no plain v4-flash route).
	cheap: {
		model:
			envModel("DISPATCH_PROFILE_CHEAP_MODEL") ??
			"aperture/neuralwatt/deepseek-v4.1-flash",
	},
	// BALANCED: Standard reviews, synthesis, general work.
	// Sonnet 5.5 (with Sol 6.1 as quota-routed counterpart via withProviderFallbacks).
	balanced: {
		model: envModel("DISPATCH_PROFILE_BALANCED_MODEL") ?? "anthropic/claude-sonnet-5-5",
	},
	// PRECISE: Security, architecture, complex features, production-critical.
	// Opus 5.5 (with Astra as quota-routed counterpart via withProviderFallbacks).
	precise: {
		model:
			envModel("DISPATCH_PROFILE_PRECISE_MODEL") ?? "anthropic/claude-opus-5-5",
	},
	// LONG: Frontend, design, image inputs, end-to-end feature builds. Kimi K3.
	long: {
		model: envModel("DISPATCH_PROFILE_LONG_MODEL") ?? KIMI_MODEL,
	},
};

export const PROFILE_TIERS: ReadonlySet<string> = new Set(
	Object.keys(PROFILES),
);

/**
 * PR review models. Opus and Astra exclude each other on failover. Every step
 * names its model, so agent rosters cannot route pr_review elsewhere.
 */
export const REVIEW_MODELS = {
	opus: envModel("DISPATCH_REVIEW_OPUS_MODEL") ?? "anthropic/claude-opus-5-5",
	astra: envModel("DISPATCH_REVIEW_ASTRA_MODEL") ?? "openai-codex/gpt-6-astra",
	preMortem: envModel("DISPATCH_REVIEW_PREMORTEM_MODEL") ?? "anthropic/claude-sonnet-5-5",
	specReuse: envModel("DISPATCH_REVIEW_SPEC_MODEL") ?? GLM_MODEL,
	slop: envModel("DISPATCH_REVIEW_SLOP_MODEL") ?? "anthropic/claude-sonnet-5-5",
	verify: envModel("DISPATCH_REVIEW_VERIFY_MODEL") ?? "anthropic/claude-sonnet-5-5",
} as const;

/** Last resort for every pr_review step. */
export const REVIEW_FALLBACK_MODELS: readonly string[] = ["anthropic/claude-sonnet-5-5"];

/**
 * Last resort for every feature_plan step, tried after the step's own chain:
 * GLM 5.3 on Neuralwatt.
 */
export const WORKFLOW_FALLBACK_MODELS: readonly string[] = [GLM_MODEL];

/** Never used by pr_review or feature_plan steps, including as Codex's terminal fallback. */
export const WORKFLOW_EXCLUDED_MODELS: readonly string[] = ["openai-codex/gpt-6.1-sol"];

/** True when a frontmatter `model` value names a tier. */
export function isProfileTier(spec: string | undefined): spec is ProfileTier {
	return !!spec && PROFILE_TIERS.has(spec);
}

/** Expand a frontmatter model value to a concrete spec. Non-tiers pass through. */
export function expandModelSpec(spec: string | undefined): string | undefined {
	if (!spec) return undefined;
	return isProfileTier(spec) ? PROFILES[spec].model : spec;
}
