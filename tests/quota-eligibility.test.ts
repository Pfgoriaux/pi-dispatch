import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { exhaustedQuotaReason, checkGlobalLowQuota } from "../src/quota.ts";
import { runWorker } from "../src/worker.ts";
import { runWorkerProc } from "../src/worker-proc.ts";
import type { AgentConfig } from "../src/types.ts";

const root = mkdtempSync(join(tmpdir(), "dispatch-eligibility-"));
const keys = ["PI_CODING_AGENT_DIR", "PI_DISPATCH_PI_BIN", "HERDR_ENV", "LINKUP_API_KEY"];
const previous = new Map(keys.map(key => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = root;
process.env.HERDR_ENV = "0";
delete process.env.LINKUP_API_KEY;
after(() => {
	for (const [key, value] of previous) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});
const cache = join(root, "cache", "usage-bar");
mkdirSync(cache, { recursive: true });
const opus = "anthropic/claude-opus-5-5";
const astra = "openai-codex/gpt-6-astra";
const sol = "openai-codex/gpt-6.1-sol";
const nw = "aperture/neuralwatt/kimi-k3";
const sy = "aperture/synthetic/hf:moonshotai/Kimi-K3";
const agent: AgentConfig = { name: "eligibility-fixture", description: "test", model: opus, tools: [], thinking: "high", systemPrompt: "fixture", source: "bundled", filePath: "fixture" };
const registry = { find: (provider: string, id: string) => ({ provider, id }) } as ModelRegistry;
const snapshot = (remaining: number, updatedAt = Date.now()) => ({ updatedAt, limits: [{ label: "week", remaining, unit: "%" as const }] });
function quota(provider: string, remaining: number, updatedAt = Date.now()) {
	writeFileSync(join(cache, `${provider}-v3.json`), JSON.stringify(snapshot(remaining, updatedAt)));
}

for (const source of ["frontmatter", "pin", "inherit", "bare-pin"] as const) {
	test(`SDK rejects exhausted Claude for ${source} without routing`, async () => {
		quota("claude", 0);
		quota("codex", 40);
		const controller = new AbortController();
		const calls: string[] = [];
		const result = await runWorker(agent, "test", {
			registry: source === "bare-pin" ? { getAll: () => [{ provider: "anthropic", id: "claude-opus-5-5" }], getAvailable: () => [] } as any : registry,
			fallbackModel: { provider: "anthropic", id: "claude-opus-5-5" } as any,
			modelSpec: source === "inherit" ? "inherit" : source === "pin" ? opus : source === "bare-pin" ? "claude-opus-5-5" : undefined,
			steerByQuota: false, signal: controller.signal,
			onAttempt: model => { calls.push(model); controller.abort(); },
		});
		assert.deepEqual(calls, source === "bare-pin" ? [] : [astra]);
		assert.equal(result.attempts, calls.length);
		assert.equal(result.status, source === "bare-pin" ? "error" : "aborted");
	});
}

test("exhausted peers and terminal fallback make zero SDK attempts", async () => {
	quota("neuralwatt", 0);
	quota("synthetic", 0);
	quota("codex", 0);
	const claimed: string[] = [];
	const result = await runWorker(agent, "test", { registry, fallbackModel: undefined, modelSpec: nw, steerByQuota: true,
		claimModel: model => { claimed.push(model); return true; },
	});
	assert.deepEqual(claimed, []);
	assert.equal(result.status, "error");
	assert.equal(result.attempts, 0);
	assert.match(result.error!, /quota exhausted/);
});

test("eligibility rereads caches and only blocks fresh, known exhaustion", () => {
	quota("claude", 0);
	assert.match(exhaustedQuotaReason(opus)!, /claude quota exhausted/);
	quota("claude", 30);
	assert.equal(exhaustedQuotaReason(opus), undefined);
	quota("claude", 0, Date.now() - 180_001);
	assert.equal(exhaustedQuotaReason(opus), undefined);
	rmSync(join(cache, "claude-v3.json"));
	assert.equal(exhaustedQuotaReason(opus), undefined);
	quota("neuralwatt", 0);
	assert.match(exhaustedQuotaReason("neuralwatt/glm-5.3")!, /neuralwatt quota exhausted/);
	assert.match(exhaustedQuotaReason("aperture/neuralwatt/glm-5.3")!, /neuralwatt quota exhausted/);
});

test("global low-quota fallback never selects a zero-headroom provider", () => {
	const now = Date.now();
	const blocked = new Map([["claude", snapshot(0, now)], ["codex", snapshot(0, now)]]);
	assert.equal(checkGlobalLowQuota(blocked, now).bestProvider, undefined);
	blocked.set("codex", snapshot(1, now));
	assert.equal(checkGlobalLowQuota(blocked, now).bestProvider, "codex");
});

const bin = join(root, "fake-pi");
writeFileSync(bin, `#!/usr/bin/env node
const model = process.argv[process.argv.indexOf('--model') + 1];
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:model}],stopReason:'stop'}}));
`, { mode: 0o700 });
process.env.PI_DISPATCH_PI_BIN = bin;

for (const source of ["frontmatter", "pin", "inherit"] as const) {
	test(`child rejects exhausted Claude for ${source} without routing`, async () => {
		quota("claude", 0);
		quota("codex", 40);
		const result = await runWorkerProc(agent, "test", { cwd: root, model: opus,
			modelOverride: source === "inherit" ? "inherit" : source === "pin" ? opus : undefined,
			steerByQuota: false,
		});
		assert.equal(result.status, "ok");
		assert.equal(result.text, astra);
		assert.equal(result.attempts, 1);
	});
}

test("child skips all exhausted routes without spawning or inheriting", async () => {
	quota("neuralwatt", 0);
	quota("synthetic", 0);
	quota("codex", 0);
	const calls: string[] = [];
	const result = await runWorkerProc(agent, "test", { cwd: root, modelOverride: nw, steerByQuota: true,
		onAttempt: model => calls.push(model),
	});
	assert.deepEqual(calls, []);
	assert.equal(result.status, "error");
	assert.equal(result.attempts, 0);
	assert.match(result.error!, /quota exhausted/);
});

test("child fallback checks updated quota before its next attempt", async () => {
	quota("neuralwatt", 50);
	quota("synthetic", 50);
	quota("codex", 50);
	writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const model = process.argv[process.argv.indexOf('--model') + 1];
if (model === ${JSON.stringify(nw)}) {
  fs.writeFileSync(${JSON.stringify(join(cache, "synthetic-v3.json"))}, JSON.stringify({updatedAt:Date.now(),limits:[{label:'week',remaining:0,unit:'%'}]}));
  process.exit(1);
}
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:model}],stopReason:'stop'}}));
`, { mode: 0o700 });
	const result = await runWorkerProc(agent, "test", { cwd: root, modelOverride: nw, steerByQuota: false });
	assert.equal(result.status, "ok");
	assert.equal(result.text, sol);
	assert.equal(result.attempts, 2, `must skip ${sy}`);
});
