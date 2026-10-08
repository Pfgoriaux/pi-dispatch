/**
 * Effort-tiered model routing for agent spawning.
 *
 * Agents request a tier by name in their frontmatter (`model: cheap`); this
 * module expands it to a concrete `provider/id` spec plus a thinking default.
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
 *   long     — Default implementation, multi-file refactors, and research
 *              across many files. Kimi K3.
 *
 * Tiers express *effort*, not identity: pick a tier by how hard a task is,
 * not by who does it. Cross-check scouting and duplicate code review need
 * deliberately different fixed models — a tier is shared, so two workers
 * on the same tier are correlated.
 *
 * Every tier model is overridable with `DISPATCH_PROFILE_<TIER>_MODEL`.
 */

export type ProfileTier = "cheap" | "balanced" | "precise" | "long";

export interface ModelProfile {
	/** Concrete model spec ("provider/id"). */
	model: string;
	/** Thinking level applied when the agent frontmatter sets none. */
	thinking: string;
}

function envModel(name: string): string | undefined {
	const v = process.env[name]?.trim();
	return v || undefined;
}

export const PROFILES: Record<ProfileTier, ModelProfile> = {
	// CHEAP: Simple tasks, file discovery, grep-and-report, boilerplate.
	// DeepSeek V4.1 Flash (Aperture has no plain v4-flash route).
	cheap: {
		model:
			envModel("DISPATCH_PROFILE_CHEAP_MODEL") ??
			"aperture/neuralwatt/deepseek-v4.1-flash",
		thinking: "off",
	},
	// BALANCED: Standard reviews, synthesis, general work.
	// Sonnet 5.5 (with Sol 6.1 as quota-routed counterpart via withProviderFallbacks).
	balanced: {
		model: envModel("DISPATCH_PROFILE_BALANCED_MODEL") ?? "anthropic/claude-sonnet-5-5",
		thinking: "high",
	},
	// PRECISE: Security, architecture, complex features, production-critical.
	// Opus 5.5 (with Astra as quota-routed counterpart via withProviderFallbacks).
	precise: {
		model:
			envModel("DISPATCH_PROFILE_PRECISE_MODEL") ?? "anthropic/claude-opus-5-5",
		thinking: "high",
	},
	// LONG: Default writer model, multi-file refactors, codebase research.
	// Kimi K3
	long: {
		model: envModel("DISPATCH_PROFILE_LONG_MODEL") ?? "aperture/neuralwatt/kimi-k3",
		thinking: "high",
	},
};

export const PROFILE_TIERS: ReadonlySet<string> = new Set(
	Object.keys(PROFILES),
);

/** PR review models. Opus and Astra exclude each other on failover. */
export const REVIEW_MODELS = {
	opus: envModel("DISPATCH_REVIEW_OPUS_MODEL") ?? "anthropic/claude-opus-5-5",
	astra: envModel("DISPATCH_REVIEW_ASTRA_MODEL") ?? "openai-codex/gpt-6-astra",
	preMortem: envModel("DISPATCH_REVIEW_PREMORTEM_MODEL") ?? "aperture/neuralwatt/deepseek-v4.1-flash",
	specReuse: envModel("DISPATCH_REVIEW_SPEC_MODEL") ?? "aperture/neuralwatt/glm-5.3",
} as const;

/**
 * Last resort for every pr_review and feature_plan step, tried after the
 * step's own chain: GLM 5.3 on Neuralwatt, then on Synthetic.
 * Aperture has no Synthetic GLM 5.3 route, so the second spec is direct.
 */
export const WORKFLOW_FALLBACK_MODELS: readonly string[] = [
	"aperture/neuralwatt/glm-5.3",
	"synthetic/hf:zai-org/GLM-5.3",
];

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

/** Tier thinking default for a frontmatter spec; undefined for non-tiers. */
export function tierThinking(spec: string | undefined): string | undefined {
	return isProfileTier(spec) ? PROFILES[spec].thinking : undefined;
}
