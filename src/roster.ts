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

/** Stable sort by weight desc; skip cooled-down candidates. */
export function rankCandidates(roster: RosterEntry[]): RankedCandidate[] {
	return roster
		.filter((entry) => !isCooledDown(entry.provider, entry.model))
		.map((entry) => ({
			entry,
			modelSpec: `${entry.provider}/${entry.model}`,
			thinking: entry.thinking,
		}))
		.sort((a, b) => b.entry.weight - a.entry.weight);
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
		return [
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
		];
	}

	return [];
}
