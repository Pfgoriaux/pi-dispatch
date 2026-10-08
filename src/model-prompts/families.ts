/**
 * Model family detection and normalization.
 *
 * Model families with prompt guidance in `adaptations.ts`.
 */

export interface ModelIdentity {
  provider: string;
  id: string;
}

export type KnownModelFamily =
  | "claude-fable-5.1"
  | "claude-opus-5.5"
  | "claude-sonnet-5.5"
  | "gpt-6-astra"
  | "gpt-6.1-sol"
  | "glm-5.3"
  | "kimi-k3"
  | "deepseek-v4.1";

/**
 * Determine the model family for a given model identity.
 * Returns undefined for unknown/unsupported models.
 */
export function knownModelFamily(
  model: ModelIdentity
): KnownModelFamily | undefined {
  const id = normalizedId(model);

  // Keep versions explicit; do not give future releases an older adaptation.
  if (id === "claude-fable-5-1" || id === "claude-fable-5.1" || id === "fable-5.1") return "claude-fable-5.1";
  if (id === "claude-opus-5-5" || id === "claude-opus-5.5") {
    return "claude-opus-5.5";
  }
  if (id === "claude-sonnet-5-5" || id === "claude-sonnet-5.5") {
    return "claude-sonnet-5.5";
  }

  // GPT-6 Sol and Luna are retired locally and intentionally get no guidance.
  if (isFamilyId(id, "gpt-6-astra")) return "gpt-6-astra";
  if (isFamilyId(id, "gpt-6.1-sol")) return "gpt-6.1-sol";

  // GLM-5.3 family (flash, flash-flex, etc.)
  if (isFamilyId(id, "glm-5.3")) return "glm-5.3";

  // Kimi K3 family
  if (isFamilyId(id, "kimi-k3")) return "kimi-k3";

  // DeepSeek 4.1 family; V4 is retired locally.
  if (isFamilyId(id, "deepseek-v4.1")) return "deepseek-v4.1";

  return undefined;
}

/**
 * Matches the family id itself or a dash-suffixed variant (e.g., `glm-5.3-flash`).
 */
function isFamilyId(id: string, family: string): boolean {
  return id === family || id.startsWith(`${family}-`);
}

/**
 * Normalize a model ID for comparison:
 * - Lowercase
 * - Strip HF prefix
 * - Extract the model name from provider-prefixed IDs
 */
function normalizedId(model: ModelIdentity): string {
  const id = model.id.toLowerCase();

  // Strip Hugging Face prefix (e.g., "hf:zai-org/GLM-5.3")
  const hfPrefix = "hf:";
  const withoutHf = id.startsWith(hfPrefix) ? id.slice(hfPrefix.length) : id;

  // Extract model name from provider-prefixed paths (e.g., "anthropic/claude-opus-5.5")
  return withoutHf.split("/").at(-1) ?? withoutHf;
}
