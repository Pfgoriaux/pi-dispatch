import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotaHeadroom, quotaProvider, readQuotaSnapshot, steerByQuota, validQuotaSnapshot, type QuotaSnapshot } from "../src/quota.ts";
import { markCooldown, resolveCandidates, withProviderFallbacks, type RankedCandidate } from "../src/roster.ts";
import type { AgentConfig } from "../src/types.ts";

const now = 2_000_000_000_000;
const nw = "aperture/neuralwatt/kimi-k3";
const sy = "aperture/synthetic/hf:moonshotai/Kimi-K3";
const codexSol = "openai-codex/gpt-6.1-sol";
const candidate = (modelSpec: string): RankedCandidate => ({ modelSpec, thinking: "high", entry: { provider: "", model: modelSpec, thinking: "high", weight: 1 } });
const snapshot = (...values: number[]): QuotaSnapshot => ({ updatedAt: now, limits: values.map((remaining, i) => ({ label: i ? "week" : "5h", remaining, unit: "%", renewal: "refill", at: now + 60_000 })) });
const routes = withProviderFallbacks([candidate(nw)]);
const specs = (cs: RankedCandidate[]) => cs.map(c => c.modelSpec);

for (const [weekly, expected] of [[100, sy], [5, nw]] as const) {
	test(`Synthetic 5h full, weekly ${weekly}%: choose ${expected}`, () => {
		const quotas = new Map([["synthetic", snapshot(100, weekly)], ["neuralwatt", snapshot(60)]]);
		const result = steerByQuota(routes, quotas, now);
		assert.equal(result.candidates[0].modelSpec, expected);
		assert.equal(result.candidates.at(-1)?.modelSpec, codexSol);
		assert.deepEqual(specs(routes), [nw, sy, codexSol], "input stays untouched");
		assert.equal(result.reasons.length, expected === sy ? 1 : 0);
	});
}

test("healthy tie spends Synthetic first; exhausted tie preserves order", () => {
	for (const value of [100, 0]) {
		const result = steerByQuota(routes, new Map([["synthetic", snapshot(value)], ["neuralwatt", snapshot(value)]]), now);
		assert.equal(result.candidates[0].modelSpec, value ? sy : nw);
	}
});

test("unknown, stale, future and expired reset snapshots leave existing ordering alone", () => {
	for (const value of [undefined, { ...snapshot(20), updatedAt: now - 180_001 }, { ...snapshot(20), updatedAt: now + 5001 },
		{ updatedAt: now, limits: [{ label: "energy", remaining: 20, unit: "%" as const, at: now, renewal: "reset" as const }] }]) {
		const quotas = new Map([["synthetic", snapshot(100, 100)]]);
		if (value) quotas.set("neuralwatt", value);
		assert.deepEqual(steerByQuota(routes, quotas, now), { candidates: routes, reasons: [] });
	}
});

test("DeepSeek 4.1 Flash steers between NeuralWatt and Synthetic; Haiku stays behind both", () => {
	const dnw = "aperture/neuralwatt/deepseek-v4.1-flash";
	const dsy = "aperture/synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash";
	const deepseek = withProviderFallbacks([candidate(dnw)]);
	for (const [synthetic, neuralwatt, first, second] of [[100, 60, dsy, dnw], [5, 60, dnw, dsy]] as const) {
		const result = steerByQuota(deepseek, new Map([["synthetic", snapshot(synthetic)], ["neuralwatt", snapshot(neuralwatt)]]), now);
		assert.deepEqual(specs(result.candidates), [first, second, "anthropic/claude-haiku-5-5", codexSol]);
	}
});

test("quota never promotes another model family", () => {
	const glm = "aperture/neuralwatt/glm-5.3";
	const mixed = withProviderFallbacks([candidate(glm), candidate(nw)]);
	const result = steerByQuota(mixed, new Map([["synthetic", snapshot(100)], ["neuralwatt", snapshot(0)]]), now);
	assert.deepEqual(specs(result.candidates), [glm, sy, nw, codexSol]);
	assert.equal(result.candidates[1].thinking, "high");
	assert.deepEqual(specs(withProviderFallbacks([candidate(glm)])), [glm, codexSol]);
});

test("physical quotas use normalized percentages; zero blocked key dominates", () => {
	const q: QuotaSnapshot = { updatedAt: now, limits: [
		{ label: "energy", remaining: 10, percentRemaining: 80, unit: "kWh" },
		{ label: "key", remaining: 0, unit: "$" },
	] };
	assert.equal(quotaHeadroom(q, now), 0);
	assert.equal(quotaHeadroom({ ...q, limits: [{ ...q.limits[0], percentRemaining: undefined }, q.limits[1]] }, now), 0);
	assert.equal(quotaHeadroom({ ...q, limits: [q.limits[0]] }, now), 80);
	assert.equal(quotaHeadroom({ ...q, limits: [q.limits[0], { label: "key", remaining: 0.01, unit: "$" }] }, now), undefined);
	assert.equal(quotaHeadroom({ ...q, limits: [{ label: "credits", remaining: 0, unit: "credits" }] }, now), undefined);
});

test("cooled roster falling through to a frontmatter pin does not enable quota steering", () => {
	const agent: AgentConfig = { name: "cooldown-fixture", description: "test", model: nw, systemPrompt: "test", source: "bundled", filePath: "fixture" };
	const config = new Map([[agent.name, [{ provider: "fixture-provider", model: "cooled", thinking: "off", weight: 1 }]]]);
	assert.equal(resolveCandidates(agent, config).quotaRouting, true);
	markCooldown("fixture-provider", "cooled");
	const resolved = resolveCandidates(agent, config);
	assert.equal(resolved.candidates[0].modelSpec, nw);
	assert.equal(resolved.quotaRouting, false);
	assert.equal(resolveCandidates({ ...agent, quotaRouting: true }, config).quotaRouting, true);
});

test("refill timestamps are not promises of restored capacity", () => {
	for (const at of [now - 1000, now + 1000]) {
		const q = snapshot(0);
		q.limits[0].at = at;
		assert.equal(quotaHeadroom(q, now), 0);
	}
});

test("v3 reader rejects corrupt or malformed data and does not require known provider names", t => {
	const dir = mkdtempSync(join(tmpdir(), "dispatch-quotas-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.equal(readQuotaSnapshot("missing", dir, now), undefined);
	for (const text of ["{", JSON.stringify({ updatedAt: now, limits: [] }), JSON.stringify(snapshot(101)), " ".repeat(16_385)]) {
		writeFileSync(join(dir, "new-provider-v3.json"), text);
		assert.equal(readQuotaSnapshot("new-provider", dir, now), undefined);
	}
	writeFileSync(join(dir, "new-provider-v3.json"), JSON.stringify(snapshot(70)));
	assert.deepEqual(readQuotaSnapshot("new-provider", dir, now), snapshot(70));
	assert.equal(readQuotaSnapshot("../new-provider", dir, now), undefined);
	assert.equal(validQuotaSnapshot({ ...snapshot(50), limits: [{ label: "bad\nlabel", remaining: 50, unit: "%" }] }, now), false);
	assert.equal(quotaProvider(sy), "synthetic");
	assert.equal(quotaProvider(nw), "neuralwatt");
	assert.equal(quotaProvider(codexSol), "codex");
});

// Top-tier model routing tests
const opus = "anthropic/claude-opus-5-5";
const astra = "openai-codex/gpt-6-astra";
const topTierRoutes = withProviderFallbacks([candidate(opus)]);

test("top-tier models steer by quota headroom (Opus 5.5 vs Astra 6)", () => {
	const quotas = new Map([["claude", snapshot(80)], ["codex", snapshot(30)]]);
	const result = steerByQuota(topTierRoutes, quotas, now);
	// Claude has more headroom, so Opus should be preferred
	assert.equal(result.candidates[0].modelSpec, opus);
	assert.equal(result.candidates[1].modelSpec, astra);
	assert.equal(result.reasons.length, 0); // no change from original order
});

test("top-tier models switch when counterpart has more headroom", () => {
	const quotas = new Map([["claude", snapshot(10)], ["codex", snapshot(90)]]);
	const result = steerByQuota(topTierRoutes, quotas, now);
	// Codex has more headroom, so Astra should be preferred
	assert.equal(result.candidates[0].modelSpec, astra);
	assert.equal(result.candidates[1].modelSpec, opus);
	assert.equal(result.reasons.length, 1);
	assert.match(result.reasons[0], /Quota routing:.*gpt-6-astra.*preferred/);
});

test("healthy top-tier tie spends Codex first", () => {
	const quotas = new Map([["claude", snapshot(80)], ["codex", snapshot(80)]]);
	const result = steerByQuota(topTierRoutes, quotas, now);
	// On a healthy tie, prefer Codex (Astra)
	assert.equal(result.candidates[0].modelSpec, astra);
});

test("mid-tier Sonnet 5.5 and Sol 6.1 steer by headroom and spend Codex on a healthy tie", () => {
	const midRoutes = withProviderFallbacks([candidate("anthropic/claude-sonnet-5-5")]);
	const low = steerByQuota(midRoutes, new Map([["claude", snapshot(10)], ["codex", snapshot(90)]]), now);
	assert.equal(low.candidates[0].modelSpec, codexSol);
	const tie = steerByQuota(midRoutes, new Map([["claude", snapshot(80)], ["codex", snapshot(80)]]), now);
	assert.equal(tie.candidates[0].modelSpec, codexSol);
	const claudeAhead = steerByQuota(midRoutes, new Map([["claude", snapshot(80)], ["codex", snapshot(30)]]), now);
	assert.equal(claudeAhead.candidates[0].modelSpec, "anthropic/claude-sonnet-5-5");
});

test("exhausted top-tier tie preserves roster order", () => {
	const quotas = new Map([["claude", snapshot(5)], ["codex", snapshot(5)]]);
	const result = steerByQuota(topTierRoutes, quotas, now);
	// On exhausted tie, preserve original order (Opus first)
	assert.equal(result.candidates[0].modelSpec, opus);
});
