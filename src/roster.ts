/**
 * Weighted model rosters with failover and cooldowns.
 *
 * Config file: <getAgentDir()>/settings/subagent-models.json
 *
 * Format (pi-harness compatible):
 *   {
 *     "<agentName>": [
 *       { "provider": "anthropic", "model": "claude-x", "thinking": "high", "weight": 1 },
 *       ...
 *     ]
 *   }
 */

import { roleFloor } from "./thinking.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type AgentConfig } from "./types.ts";

export interface RosterEntry {
	provider: string;
	model: string;
	thinking: string;
	weight: number;
}

export interface RankedCandidate {
	modelSpec: string;
	thinking: string;
	entry: RosterEntry;
}

const COOLDOWN_MS = 60_000;

/** Module-scope in-memory cooldown map keyed "provider/model". */
const cooldowns = new Map<string, number>();

/** Record a failure timestamp for a provider/model. */
export function markCooldown(provider: string, model: string): void {
	cooldowns.set(`${provider}/${model}`, Date.now());
}

/** Check if a provider/model is currently cooled down. */
export function isCooledDown(provider: string, model: string): boolean {
	const last = cooldowns.get(`${provider}/${model}`);
	if (!last) return false;
	if (Date.now() - last < COOLDOWN_MS) return true;
	cooldowns.delete(`${provider}/${model}`);
	return false;
}

function isValidRosterEntry(entry: unknown): entry is RosterEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	if (typeof e.provider !== "string" || !e.provider) return false;
	if (typeof e.model !== "string" || !e.model) return false;
	// thinking is OPTIONAL (defaults to the role floor) but must be valid when present.
	if (
		typeof e.thinking !== "undefined" &&
		(typeof e.thinking !== "string" || !THINKING_LEVELS.has(e.thinking))
	) {
		return false;
	}
	if (typeof e.weight !== "number" || !Number.isFinite(e.weight) || e.weight <= 0) {
		return false;
	}
	return true;
}

/** Validate and normalize one agent's roster list. Returns undefined if invalid. */
function normalizeRoster(agentName: string, entries: unknown): RosterEntry[] | undefined {
	if (!Array.isArray(entries)) return undefined;
	const dropped = entries.length;
	const valid = entries.filter(isValidRosterEntry).map((e) => ({
		...e,
		thinking: e.thinking ?? roleFloor(agentName),
	}));
	if (valid.length === 0) return undefined;
	if (valid.length < dropped) {
		// Never silent: a fat-fingered roster silently falling back to the
		// inherited model is exactly the kind of misconfiguration to surface.
		process.stderr.write(
			`[pi-dispatch] roster: dropped ${dropped - valid.length} invalid entr${dropped - valid.length === 1 ? "y" : "ies"}\n`,
		);
	}
	return valid;
}

let cachedConfig: Promise<Map<string, RosterEntry[]> | undefined> | undefined;

/** Load the roster config once; cached promise, never throws. */
export function loadRosterConfig(): Promise<Map<string, RosterEntry[]> | undefined> {
	if (cachedConfig) return cachedConfig;
	cachedConfig = (async () => {
		const filePath = path.join(getAgentDir(), "settings", "subagent-models.json");
		let text: string;
		try {
			text = await fs.promises.readFile(filePath, "utf-8");
		} catch {
			return undefined;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return undefined;
		}

		if (typeof parsed !== "object" || parsed === null) return undefined;

		const map = new Map<string, RosterEntry[]>();
		for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
			const roster = normalizeRoster(name, value);
			if (roster) map.set(name, roster);
		}
		return map.size > 0 ? map : undefined;
	})();
	return cachedConfig;
}

// Neuralwatt models whose failures fall back to Codex 6.1 Sol. Do not guess IDs.
// GLM Flash and Kimi fast variants are not used.
const NEURALWATT_ROUTES = new Set(["neuralwatt/kimi-k3", "neuralwatt/glm-5.3", "neuralwatt/deepseek-v4.1-flash"]);

// DeepSeek 4.1 falls back to Haiku 5.5, then the terminal 6.1 Sol.
// Haiku spends Anthropic quota only when Neuralwatt fails.
const DEEPSEEK_ROUTE = "neuralwatt/deepseek-v4.1-flash";
const DEEPSEEK_FALLBACK = "anthropic/claude-haiku-5-5";

const OPENAI_FALLBACK = "openai-codex/gpt-6.1-sol";

// Anthropic ↔ OpenAI Codex peers, interchangeable at the same effort level.
// top-tier: Opus 5.5 ↔ Astra 6 (complex features, architecture, security).
// mid-tier: Sonnet 5.5 → Sol 6.1 (reviews, synthesis, general work).
// Sol is also every chain's terminal fallback, so it never expands to Sonnet
// (that would make re-expansion non-idempotent); both still share a quota family.
const CROSS_PROVIDER_PEERS = new Map<string, { peer?: string; family: "top-tier" | "mid-tier" }>([
	["anthropic/claude-opus-5-5", { peer: "openai-codex/gpt-6-astra", family: "top-tier" }],
	["openai-codex/gpt-6-astra", { peer: "anthropic/claude-opus-5-5", family: "top-tier" }],
	["anthropic/claude-sonnet-5-5", { peer: OPENAI_FALLBACK, family: "mid-tier" }],
	[OPENAI_FALLBACK, { family: "mid-tier" }],
]);

const routeId = (spec: string) => spec.replace(/^aperture\//, "");

// Claude subscription accounts registered by pi-ant: same model IDs, separate quotas.
const CLAUDE_ACCOUNTS = ["anthropic", "anthropic-2"];
const claudeModel = (spec: string) => /^anthropic(?:-2)?\/(.+)$/.exec(spec)?.[1];

/** One spec per Claude account for the same model; other specs map to themselves. */
function accountRoutes(spec: string): string[] {
	const id = claudeModel(spec);
	if (!id) return [spec];
	return [spec, ...CLAUDE_ACCOUNTS.map((account) => `${account}/${id}`).filter((route) => route !== spec)];
}

/** The first-account spec for a direct Claude route; other specs map to themselves. */
function primaryAccount(spec: string): string {
	const id = claudeModel(spec);
	return id ? `anthropic/${id}` : spec;
}

/** Model identity across Claude accounts and the Aperture prefix. */
export function sameModelId(spec: string): string {
	return primaryAccount(routeId(spec));
}

/** Drop candidates naming an excluded model, on any Claude account, with or without the Aperture prefix. */
export function withoutModels(candidates: RankedCandidate[], excluded: readonly string[] = []): RankedCandidate[] {
	const ids = new Set(excluded.map(sameModelId));
	return candidates.filter((c) => !ids.has(sameModelId(c.modelSpec)));
}

/** Append last-resort specs not already in the chain, keeping their order. */
export function withLastResorts(candidates: RankedCandidate[], specs: readonly string[] = [], thinking: string): RankedCandidate[] {
	const present = new Set(candidates.map((c) => sameModelId(c.modelSpec)));
	const extra = specs.filter((spec) => !present.has(sameModelId(spec))).map((modelSpec) => ({
		modelSpec,
		thinking,
		entry: { provider: modelSpec.slice(0, modelSpec.indexOf("/")), model: modelSpec.slice(modelSpec.indexOf("/") + 1), thinking, weight: 1 },
	}));
	return [...candidates, ...extra];
}

/** Exact-model equivalence only; unknown models must never be guessed. */
export function quotaFamily(spec: string): string | undefined {
	// Cross-provider peers (Opus 5.5 ↔ Astra 6, Sonnet 5.5 ↔ Sol 6.1), then other Claude models across accounts
	const id = primaryAccount(spec);
	return CROSS_PROVIDER_PEERS.get(id)?.family ?? (claudeModel(id) ? id : undefined);
}

/**
 * Known cross-provider peers, then Codex 6.1 Sol once, last.
 * Every Claude route is followed by the same model on the other Claude account.
 */
export function withProviderFallbacks(candidates: RankedCandidate[]): RankedCandidate[] {
	const seen = new Set<string>();
	const result: RankedCandidate[] = [];
	let terminal: RankedCandidate | undefined;
	const at = (candidate: RankedCandidate, modelSpec: string): RankedCandidate => ({
		...candidate,
		modelSpec,
		entry: { ...candidate.entry, provider: modelSpec.slice(0, modelSpec.indexOf("/")), model: modelSpec.slice(modelSpec.indexOf("/") + 1) },
	});
	const append = (candidate: RankedCandidate) => {
		for (const route of accountRoutes(candidate.modelSpec)) {
			if (seen.has(route)) continue;
			seen.add(route);
			result.push(route === candidate.modelSpec ? candidate : candidates.find(c => c.modelSpec === route) ?? at(candidate, route));
		}
	};
	for (const candidate of candidates) {
		// Cross-provider peers (Opus 5.5 ↔ Astra 6, Sonnet 5.5 → Sol 6.1)
		const crossPeer = CROSS_PROVIDER_PEERS.get(primaryAccount(candidate.modelSpec))?.peer;
		append(candidate);
		if (crossPeer) {
			// Prefer an explicit counterpart configuration if present
			const existingPeer = candidates.find(c => c.modelSpec === crossPeer);
			append(existingPeer ?? at(candidate, crossPeer));
			// Sonnet → Sol already contains Sol as its peer.
			if (crossPeer !== OPENAI_FALLBACK) terminal ??= at(candidate, OPENAI_FALLBACK);
			continue;
		}
		const route = routeId(candidate.modelSpec);
		if (!NEURALWATT_ROUTES.has(route)) continue;
		if (route === DEEPSEEK_ROUTE) {
			append(candidates.find(c => c.modelSpec === DEEPSEEK_FALLBACK) ?? at(candidate, DEEPSEEK_FALLBACK));
		}
		terminal ??= at(candidate, OPENAI_FALLBACK);
	}
	// Preserve explicit 6.1 Sol settings, but keep it after all provider routes.
	if (terminal) {
		const explicit = result.find(c => c.modelSpec === OPENAI_FALLBACK);
		return [...result.filter(c => c.modelSpec !== OPENAI_FALLBACK), explicit ?? terminal];
	}
	return result;
}

/** Stable sort by weight desc; expand routes before checking their own cooldowns. */
export function rankCandidates(roster: RosterEntry[]): RankedCandidate[] {
	return withProviderFallbacks(roster
		.map((entry) => ({
			entry,
			modelSpec: `${entry.provider}/${entry.model}`,
			thinking: entry.thinking,
		}))
		.sort((a, b) => b.entry.weight - a.entry.weight))
		.filter(({ entry }) => !isCooledDown(entry.provider, entry.model));
}

/** Resolve the ordered candidate list for an agent: roster → frontmatter → inherit. */
export function resolveCandidates(
	agent: AgentConfig,
	config: Map<string, RosterEntry[]> | undefined,
): { candidates: RankedCandidate[]; quotaRouting: boolean } {
	const roster = config?.get(agent.name);
	if (roster) {
		const ranked = rankCandidates(roster);
		if (ranked.length > 0) return { candidates: ranked, quotaRouting: true };
	}

	if (agent.model && agent.model !== "inherit") {
		const candidates = withProviderFallbacks([
			{
				modelSpec: agent.model,
				thinking: agent.thinking ?? roleFloor(agent.name),
				entry: {
					provider:
						agent.model.includes("/") ? agent.model.split("/", 2)[0] : "inherit",
					model: agent.model.includes("/")
						? agent.model.slice(agent.model.indexOf("/") + 1)
						: agent.model,
					thinking: agent.thinking ?? roleFloor(agent.name),
					weight: 1,
				},
			},
		]);
		return { candidates, quotaRouting: agent.quotaRouting === true };
	}

	return { candidates: [], quotaRouting: false };
}
