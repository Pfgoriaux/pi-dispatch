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
	// thinking is OPTIONAL (defaults to "off") but must be valid when present.
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
function normalizeRoster(entries: unknown): RosterEntry[] | undefined {
	if (!Array.isArray(entries)) return undefined;
	const dropped = entries.length;
	const valid = entries.filter(isValidRosterEntry).map((e) => ({
		...e,
		thinking: e.thinking ?? "off",
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
			const roster = normalizeRoster(value);
			if (roster) map.set(name, roster);
		}
		return map.size > 0 ? map : undefined;
	})();
	return cachedConfig;
}

// Model counterparts in Aperture's Synthetic catalog. Do not guess IDs.
// Where Synthetic has no exact variant (plain GLM 5.3 is Flash-only there),
// the closest deliberate substitute is mapped: glm-5.3 (non-flash) →
// GLM-5.3-Flash. Keep the requested provider first, then its counterpart.
const SYNTHETIC_COUNTERPARTS = new Map([
	["kimi-k3", "hf:moonshotai/Kimi-K3"],
	["glm-5.3", "hf:zai-org/GLM-5.3-Flash"],
	["glm-5.3-flash", "hf:zai-org/GLM-5.3-Flash"],
]);

const OPENAI_FALLBACK = "openai-codex/gpt-5.6-terra";
const routeId = (spec: string) => spec.replace(/^aperture\//, "");

/** Known provider counterparts in either direction, then Codex Terra once, last. */
export function withProviderFallbacks(candidates: RankedCandidate[]): RankedCandidate[] {
	const seen = new Set<string>();
	const result: RankedCandidate[] = [];
	let terminal: RankedCandidate | undefined;
	const append = (candidate: RankedCandidate) => {
		if (seen.has(candidate.modelSpec)) return;
		seen.add(candidate.modelSpec);
		result.push(candidate);
	};
	const at = (candidate: RankedCandidate, modelSpec: string): RankedCandidate => ({
		...candidate,
		modelSpec,
		entry: { ...candidate.entry, provider: modelSpec.slice(0, modelSpec.indexOf("/")), model: modelSpec.slice(modelSpec.indexOf("/") + 1) },
	});
	for (const candidate of candidates) {
		const route = routeId(candidate.modelSpec);
		let counterpart: string | undefined;
		if (route.startsWith("neuralwatt/")) {
			const synthetic = SYNTHETIC_COUNTERPARTS.get(route.slice("neuralwatt/".length));
			if (synthetic) counterpart = `synthetic/${synthetic}`;
		} else if (route.startsWith("synthetic/")) {
			const synthetic = route.slice("synthetic/".length);
			// Prefer an already specified variant; otherwise Flash maps back to Flash.
			const existing = candidates.find(c => {
				const id = routeId(c.modelSpec);
				return id.startsWith("neuralwatt/") && SYNTHETIC_COUNTERPARTS.get(id.slice("neuralwatt/".length)) === synthetic;
			});
			const id = [...SYNTHETIC_COUNTERPARTS].reverse().find(([, value]) => value === synthetic)?.[0];
			if (id) counterpart = existing ? routeId(existing.modelSpec) : `neuralwatt/${id}`;
		}
		append(candidate);
		if (!counterpart) continue;
		const existing = candidates.find(c => routeId(c.modelSpec) === counterpart);
		append(existing ?? at(candidate, `aperture/${counterpart}`));
		terminal ??= at(candidate, OPENAI_FALLBACK);
	}
	// Preserve explicit Terra settings, but keep it after all provider routes.
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
): RankedCandidate[] {
	const roster = config?.get(agent.name);
	if (roster) {
		const ranked = rankCandidates(roster);
		if (ranked.length > 0) return ranked;
	}

	if (agent.model && agent.model !== "inherit") {
		return withProviderFallbacks([
			{
				modelSpec: agent.model,
				thinking: agent.thinking ?? "off",
				entry: {
					provider:
						agent.model.includes("/") ? agent.model.split("/", 2)[0] : "inherit",
					model: agent.model.includes("/")
						? agent.model.slice(agent.model.indexOf("/") + 1)
						: agent.model,
					thinking: agent.thinking ?? "off",
					weight: 1,
				},
			},
		]);
	}

	return [];
}
