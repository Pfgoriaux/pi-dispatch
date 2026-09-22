/**
 * Effort-tiered model routing — a local implementation of the Routing-Profile
 * concept (named tiers exposed as model choices), adapted because we do not
 * (yet) run the gateway side.
 *
 * Agents request a tier by name in their frontmatter (`model: cheap`); this
 * module expands it to a concrete `provider/id` spec plus a thinking default.
 * "inherit" and explicit provider/id specs keep their existing meaning.
 *
 * Tiers express *effort*, not identity: pick a tier by how hard a task is,
 * not by who does it. Anything needing model independence (cross-check
 * scouting, duplicate code review) must use deliberately different fixed
 * models — a tier is shared, so two workers on the same tier are correlated.
 *
 * Defaults are provisional where marked; every tier model is overridable with
 * `DISPATCH_PROFILE_<TIER>_MODEL` (full `provider/id` spec).
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
	// Fast, cheap, good-enough for grep-and-report recon.
	cheap: {
		model:
			envModel("DISPATCH_PROFILE_CHEAP_MODEL") ??
			"neuralwatt/deepseek-v4.1-flash",
		thinking: "off",
	},
	// General-purpose workhorse. Provisional default.
	balanced: {
		model: envModel("DISPATCH_PROFILE_BALANCED_MODEL") ?? "neuralwatt/glm-5.3",
		thinking: "high",
	},
	// Top model for high-skill tasks (planning, security review).
	precise: {
		model:
			envModel("DISPATCH_PROFILE_PRECISE_MODEL") ?? "openai-codex/gpt-6-astra",
		thinking: "high",
	},
	// Dedicated model for long-effort/long-baseline tasks (Kimi-3).
	long: {
		model: envModel("DISPATCH_PROFILE_LONG_MODEL") ?? "neuralwatt/kimi-k3",
		thinking: "high",
	},
};

export const PROFILE_TIERS: ReadonlySet<string> = new Set(
	Object.keys(PROFILES),
);

/**
 * Cross-check pair with different model families. Both defaults run via
 * Neuralwatt through Aperture first and fail over to Aperture's Synthetic
 * counterparts when Neuralwatt credits run out (kimi-k3 → Kimi-K3,
 * glm-5.3 → GLM-5.3-Flash, Synthetic's only GLM 5.3 variant). Operators can
 * choose separate providers with DISPATCH_DIVERSE_0_MODEL / DISPATCH_DIVERSE_1_MODEL.
 * Different families reduce shared blind spots; they do not prove independence.
 */
export const DIVERSE_PAIR: readonly [string, string] = [
	envModel("DISPATCH_DIVERSE_0_MODEL") ?? "aperture/neuralwatt/glm-5.3",
	envModel("DISPATCH_DIVERSE_1_MODEL") ?? "aperture/neuralwatt/kimi-k3",
];

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
