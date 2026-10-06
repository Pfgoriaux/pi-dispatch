/** Read-only consumer of pi-usage-bar's versioned, credential-free cache. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { quotaFamily, type RankedCandidate } from "./roster.ts";

/** Threshold below which a provider is considered "running low" (%). */

/** All tracked providers for global fallback. */
const ALL_PROVIDERS = ["codex", "synthetic", "neuralwatt", "claude"] as const;

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
	return provider;
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

/** Bottleneck across ALL reported windows. Never forecast capacity from a future refill. */
export function quotaHeadroom(snapshot: QuotaSnapshot | undefined, now = Date.now()): number | undefined {
	if (!snapshot || !validQuotaSnapshot(snapshot, now) || now - snapshot.updatedAt > 180_000
		|| snapshot.limits.some(l => l.renewal !== "refill" && l.at !== undefined && l.at <= now)) return undefined;
	const percentages = snapshot.limits.flatMap(l => {
		const percent = l.unit === "%" ? l.remaining : l.percentRemaining;
		if (percent !== undefined) return [percent];
		// Optional paid Codex credits are not a subscription quota window.
		return l.unit !== "credits" && l.remaining <= 0 ? [0] : [];
	});
	if (!percentages.length) return undefined;
	const headroom = Math.min(...percentages);
	// A positive physical balance without its total is not comparable headroom.
	// A known exhausted window still proves the provider has no headroom.
	if (headroom > 0 && snapshot.limits.some(l => l.unit !== "%" && l.unit !== "credits"
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
	for (const [family, indices] of groups.entries()) {
		if (indices.length < 2) continue;
		const peers = indices.map(index => {
			const candidate = candidates[index];
			const provider = quotaProvider(candidate.modelSpec);
			return { candidate, provider, headroom: quotaHeadroom(snapshots.get(provider), now) };
		});
		// An unknown reading is neither free capacity nor an exhausted subscription.
		if (peers.some(p => p.headroom === undefined)) continue;
		peers.sort((a, b) => b.headroom! - a.headroom!
			// For NeuralWatt/Synthetic: spend Synthetic first on a healthy tie.
			// For Anthropic/Codex peers (Opus/Astra, Sonnet/Sol): spend Codex first on a healthy tie.
			|| (a.headroom! >= 50 ? (
				family === "top-tier" || family === "mid-tier"
					? Number(b.provider === "codex") - Number(a.provider === "codex")
					: Number(b.provider === "synthetic") - Number(a.provider === "synthetic")
			) : 0));
		if (peers.every((p, i) => p.candidate === candidates[indices[i]])) continue;
		indices.forEach((index, i) => { ordered[index] = peers[i].candidate; });
		reasons.push(`Quota routing: ${peers[0].candidate.modelSpec} preferred (${peers.map(p => `${p.provider} ${Math.floor(p.headroom!)}% bottleneck remaining`).join("; ")}).`);
	}
	return { candidates: ordered, reasons };
}

/** Hard eligibility check, independent of advisory routing and explicit model pins. */
export function exhaustedQuotaReason(spec: string): string | undefined {
	const provider = quotaProvider(spec);
	const now = Date.now();
	const snapshot = readQuotaSnapshot(provider, join(getAgentDir(), "cache", "usage-bar"), now);
	if (quotaHeadroom(snapshot, now) !== 0) return undefined;
	return `Skipped ${spec}: ${provider} quota exhausted (0% bottleneck remaining)`;
}

/** Called once before attempts; parallel workers never mutate snapshots or reserve invented token costs. */
export function quotaCandidates(candidates: RankedCandidate[], onWarning?: (reason: string) => void): RankedCandidate[] {
	const directory = join(getAgentDir(), "cache", "usage-bar");
	const now = Date.now();
	const snapshots = new Map<string, QuotaSnapshot>();

	// Read snapshots only to rank existing peer candidates
	for (const provider of ALL_PROVIDERS) {
		const snapshot = readQuotaSnapshot(provider, directory, now);
		if (snapshot) snapshots.set(provider, snapshot);
	}

	const result = steerByQuota(candidates, snapshots, now);
	for (const reason of result.reasons) onWarning?.(reason);
	return result.candidates;
}
