/** Read-only consumer of pi-usage-bar's versioned, credential-free cache. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { GLM_MODEL } from "./profiles.ts";
import { quotaFamily, sameModelId, withProviderFallbacks, type RankedCandidate } from "./roster.ts";


/** Providers whose quota snapshots are read. */
const ALL_PROVIDERS = ["codex", "claude", "claude2"] as const;

interface Limit {
	label: string;
	remaining: number;
	percentRemaining?: number;
	unit: "%" | "$" | "kWh" | "credits";
	at?: number;
	renewal?: "reset" | "refill";
}
export interface QuotaSnapshot { updatedAt: number; limits: Limit[] }
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const object = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Mirrors usage-bar's v3 wire contract without importing a separately versioned extension. */
export function validQuotaSnapshot(value: unknown, now = Date.now()): value is QuotaSnapshot {
	const s = object(value);
	return finite(s.updatedAt) && s.updatedAt > 0 && s.updatedAt <= now + 5000
		&& Array.isArray(s.limits) && s.limits.length > 0 && s.limits.length <= 5
		&& s.limits.every(raw => {
			const l = object(raw);
			return typeof l.label === "string" && /^[a-z0-9]{1,16}$/.test(l.label)
				&& finite(l.remaining)
				&& (l.percentRemaining === undefined || (finite(l.percentRemaining) && l.percentRemaining >= 0 && l.percentRemaining <= 100))
				&& ["%", "$", "kWh", "credits"].includes(String(l.unit))
				&& (l.unit !== "%" || (l.remaining >= 0 && l.remaining <= 100))
				&& (l.at === undefined || (finite(l.at) && l.at > 0))
				&& (l.renewal === undefined || l.renewal === "reset" || l.renewal === "refill");
		});
}

export function quotaProvider(spec: string): string {
	const provider = spec.replace(/^aperture\//i, "").split("/")[0].toLowerCase();
	if (provider === "openai-codex") return "codex";
	if (provider === "anthropic") return "claude";
	// pi-usage-bar names the second Claude account's cache "claude2".
	if (provider === "anthropic-2") return "claude2";
	return provider;
}

/**
 * Claude reports per-model weekly windows as `<model>week` (fableweek, opus55week,
 * sonnetweek). They bind only the model whose ID contains that name. Without a
 * spec, or for other providers, every window counts.
 */
function bindsModel(limit: Limit, spec?: string): boolean {
	const scope = /^(.+)week$/.exec(limit.label)?.[1];
	if (!scope || !spec || !quotaProvider(spec).startsWith("claude")) return true;
	return spec.slice(spec.lastIndexOf("/") + 1).toLowerCase().replace(/[^a-z0-9]/g, "").includes(scope);
}

export function readQuotaSnapshot(provider: string, directory: string, now = Date.now()): QuotaSnapshot | undefined {
	if (!/^[a-z0-9-]{1,64}$/.test(provider)) return undefined;
	try {
		const text = readFileSync(join(directory, `${provider}-v3.json`), "utf8");
		if (text.length > 16_384) return undefined;
		const value: unknown = JSON.parse(text);
		return validQuotaSnapshot(value, now) ? value : undefined;
	} catch { return undefined; }
}

/** Percent left in one window; a physical balance at or below zero counts as 0%. */
function percentLeft(l: Limit): number | undefined {
	const percent = l.unit === "%" ? l.remaining : l.percentRemaining;
	if (percent !== undefined) return percent;
	// Optional paid Codex credits are not a subscription quota window.
	return l.unit !== "credits" && l.remaining <= 0 ? 0 : undefined;
}

/** Bottleneck across every window that binds `spec`. Never forecast capacity from a future refill. */
export function quotaHeadroom(snapshot: QuotaSnapshot | undefined, now = Date.now(), spec?: string): number | undefined {
	if (!snapshot || !validQuotaSnapshot(snapshot, now) || now - snapshot.updatedAt > 180_000) return undefined;
	const limits = snapshot.limits.filter(l => bindsModel(l, spec));
	if (limits.some(l => l.renewal !== "refill" && l.at !== undefined && l.at <= now)) return undefined;
	const percentages = limits.map(percentLeft).filter((p): p is number => p !== undefined);
	if (!percentages.length) return undefined;
	const headroom = Math.min(...percentages);
	// A positive physical balance without its total is not comparable headroom.
	// A known exhausted window still proves the provider has no headroom.
	if (headroom > 0 && limits.some(l => l.unit !== "%" && l.unit !== "credits"
		&& l.percentRemaining === undefined && l.remaining > 0)) return undefined;
	return headroom;
}

/** Reorder only exact-model peers, keeping roster family priorities and Codex fallback intact. */
export function steerByQuota(
	candidates: RankedCandidate[],
	snapshots: ReadonlyMap<string, QuotaSnapshot>,
	now = Date.now(),
): { candidates: RankedCandidate[]; reasons: string[] } {
	const ordered = [...candidates];
	const groups = new Map<string, number[]>();
	for (const [index, candidate] of candidates.entries()) {
		const family = quotaFamily(candidate.modelSpec);
		if (family) groups.set(family, [...(groups.get(family) ?? []), index]);
	}
	const reasons: string[] = [];
	for (const indices of groups.values()) {
		// An unknown reading is neither free capacity nor an exhausted subscription: it keeps its slot.
		const peers = indices.map(index => {
			const candidate = candidates[index];
			const provider = quotaProvider(candidate.modelSpec);
			return { index, candidate, provider, headroom: quotaHeadroom(snapshots.get(provider), now, candidate.modelSpec) };
		}).filter(p => p.headroom !== undefined);
		if (peers.length < 2) continue;
		const slots = peers.map(p => p.index);
		// Spend Codex first on a healthy tie.
		peers.sort((a, b) => b.headroom! - a.headroom!
			|| (a.headroom! >= 50 ? Number(b.provider === "codex") - Number(a.provider === "codex") : 0));
		if (peers.every((p, i) => p.index === slots[i])) continue;
		slots.forEach((index, i) => { ordered[index] = peers[i].candidate; });
		reasons.push(`Quota routing: ${peers[0].candidate.modelSpec} preferred (${peers.map(p => `${p.provider} ${Math.floor(p.headroom!)}% bottleneck remaining`).join("; ")}).`);
	}
	return { candidates: ordered, reasons };
}

/** Hard eligibility check, independent of advisory routing and explicit model pins. */
export function exhaustedQuotaReason(spec: string): string | undefined {
	const provider = quotaProvider(spec);
	const now = Date.now();
	const snapshot = readQuotaSnapshot(provider, join(getAgentDir(), "cache", "usage-bar"), now);
	if (quotaHeadroom(snapshot, now, spec) !== 0) return undefined;
	const empty = snapshot!.limits.filter(l => bindsModel(l, spec) && percentLeft(l) === 0).map(l => l.label);
	return `Skipped ${spec}: ${provider} quota exhausted (${empty.join(", ")} at 0%)`;
}

/** GLM 5.3 leads a dispatch chain only while no Opus/Astra route has more than this percentage left. */
export const GLM_GATE_PERCENT = 30;
const OPUS = "anthropic/claude-opus-5-5";
const TOP_TIER_ROUTES = [OPUS, "anthropic-2/claude-opus-5-5", "openai-codex/gpt-6-astra"];

/**
 * Put Opus/Astra ahead of a GLM-led chain while one has more than GLM_GATE_PERCENT left.
 * GLM stays next in the chain. Unknown readings do not count as headroom.
 */
export function gateGlm(
	candidates: RankedCandidate[],
	snapshots: ReadonlyMap<string, QuotaSnapshot>,
	now = Date.now(),
): { candidates: RankedCandidate[]; reasons: string[] } {
	const lead = candidates[0];
	if (!lead || sameModelId(lead.modelSpec) !== sameModelId(GLM_MODEL)) return { candidates, reasons: [] };
	const best = Math.max(...TOP_TIER_ROUTES.map(spec => quotaHeadroom(snapshots.get(quotaProvider(spec)), now, spec) ?? 0));
	if (best <= GLM_GATE_PERCENT) return { candidates, reasons: [] };
	const opus = { ...lead, modelSpec: OPUS, entry: { ...lead.entry, provider: "anthropic", model: "claude-opus-5-5" } };
	const steered = steerByQuota(withProviderFallbacks([opus, ...candidates]), snapshots, now);
	return {
		candidates: steered.candidates,
		reasons: [`GLM gate: Opus/Astra lead (${Math.floor(best)}% best remaining > ${GLM_GATE_PERCENT}%); ${lead.modelSpec} follows.`, ...steered.reasons],
	};
}

function readSnapshots(now: number): Map<string, QuotaSnapshot> {
	const directory = join(getAgentDir(), "cache", "usage-bar");
	const snapshots = new Map<string, QuotaSnapshot>();
	for (const provider of ALL_PROVIDERS) {
		const snapshot = readQuotaSnapshot(provider, directory, now);
		if (snapshot) snapshots.set(provider, snapshot);
	}
	return snapshots;
}

function report(result: { candidates: RankedCandidate[]; reasons: string[] }, onWarning?: (reason: string) => void): RankedCandidate[] {
	for (const reason of result.reasons) onWarning?.(reason);
	return result.candidates;
}

/** Called once before attempts; parallel workers never mutate snapshots or reserve invented token costs. */
export function quotaCandidates(candidates: RankedCandidate[], onWarning?: (reason: string) => void): RankedCandidate[] {
	const now = Date.now();
	return report(steerByQuota(candidates, readSnapshots(now), now), onWarning);
}

/** Applies gateGlm to fresh snapshots, once before attempts. */
export function glmGateCandidates(candidates: RankedCandidate[], onWarning?: (reason: string) => void): RankedCandidate[] {
	const now = Date.now();
	return report(gateGlm(candidates, readSnapshots(now), now), onWarning);
}
