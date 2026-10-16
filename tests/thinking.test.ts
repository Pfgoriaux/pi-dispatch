import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createAgentSessionServices, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isTaskThinking, resolveRequest, resolveEffective, workflowThinking, effortLabel } from "../src/thinking.ts";
import { runWorker, effortSummary } from "../src/worker.ts";
import { runWorkerProc } from "../src/worker-proc.ts";
import type { AgentConfig } from "../src/types.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";
import { thinkingFixture, thinkingModel } from "./thinking-fixture.ts";

isolateAgentDir();
fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR!, "settings"), { recursive: true });
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "settings/subagent-models.json"), JSON.stringify({
	"thinking-roster": [
		{ provider: "fixture", model: "model", thinking: "medium", weight: 2 },
		{ provider: "fixture", model: "alternate", thinking: "max", weight: 1 },
	],
	"scout": [{ provider: "fixture", model: "model", weight: 1 }],
	"reviewer": [{ provider: "fixture", model: "model", weight: 1 }],
}));
const agent: AgentConfig = { name: "thinking-fixture", description: "fixture", tools: [], model: "fixture/model", thinking: "low", systemPrompt: "fixture", source: "bundled", filePath: "fixture.md" };

test("request precedence and role floors do not depend on model tiers", () => {
	const level = (r: ReturnType<typeof resolveRequest>) => r.level;
	assert.deepEqual(resolveRequest({}), { level: "high", explicit: false });
	assert.equal(level(resolveRequest({ task: "max", savedResume: "high", agentConfig: "off" })), "max");
	assert.equal(level(resolveRequest({ task: "xhigh", savedResume: "max", agentConfig: "high" })), "xhigh");
	assert.deepEqual(resolveRequest({ savedResume: "max", agentConfig: "high" }), { level: "max", explicit: true });
	assert.deepEqual(resolveRequest({ agentConfig: "xhigh" }), { level: "xhigh", explicit: false });
	for (const legacy of ["off", "minimal", "low", "medium"]) {
		const warnings: string[] = [];
		assert.deepEqual(resolveRequest({ agentConfig: legacy }, "reviewer", "fixture", w => warnings.push(w)), { level: "high", explicit: false });
		assert.match(warnings[0], /fixture: thinking .* raised to high/);
		assert.equal(level(resolveRequest({ savedResume: legacy, resumeSource: "/sessions/old.jsonl" }, "writer", "wrong agent", w => warnings.push(w))), "high");
		assert.match(warnings[1], /Resumed session \/sessions\/old.jsonl: thinking .* raised to high/);
		assert.throws(() => resolveRequest({ task: legacy }, "reviewer"), /below the reviewer floor high/);
	}
	// Role floors: scouts default to low, aggregators and slop reviewers to medium; roster values at or above the floor are kept.
	assert.deepEqual(resolveRequest({}, "scout"), { level: "low", explicit: false });
	assert.deepEqual(resolveRequest({ agentConfig: "off" }, "scout", "roster", () => {}), { level: "low", explicit: false });
	assert.deepEqual(resolveRequest({ agentConfig: "high" }, "scout"), { level: "high", explicit: false });
	assert.deepEqual(resolveRequest({ task: "low" }, "scout"), { level: "low", explicit: true });
	assert.throws(() => resolveRequest({ task: "off" }, "scout"), /below the scout floor low/);
	assert.deepEqual(resolveRequest({}, "aggregator"), { level: "medium", explicit: false });
	assert.deepEqual(resolveRequest({}, "slop-reviewer"), { level: "medium", explicit: false });
	assert.deepEqual(resolveRequest({ task: "max" }, "aggregator"), { level: "max", explicit: true });
	assert.equal(workflowThinking("reviewer", "xhigh"), "xhigh");
	assert.equal(workflowThinking("writer", "max"), "max");
	assert.equal(workflowThinking("scout", "max"), undefined);
	assert.equal(workflowThinking("aggregator", "high"), undefined);
	assert.equal(isTaskThinking("max"), true);
	assert.equal(isTaskThinking("medium"), false);
	assert.throws(() => resolveRequest({ task: "typo" }), /Unsupported/);
	assert.throws(() => resolveRequest({ agentConfig: "typo" }), /Unsupported/);
});

test("explicit efforts need exact support; defaults rise to the nearest supported level", () => {
	const model = thinkingModel();
	assert.deepEqual(resolveEffective("max", model), { effective: "max", verified: true });
	assert.deepEqual(resolveEffective("xhigh"), { effective: "xhigh", verified: false });
	assert.throws(() => resolveEffective("high", { ...model, reasoning: false }), /supported choices: off/);
	assert.throws(() => resolveEffective("xhigh", { ...model, thinkingLevelMap: { xhigh: null, max: "max" } }), /Unsupported thinking xhigh.*supported choices:.*high, max/);
	assert.throws(() => resolveEffective("max", { ...model, thinkingLevelMap: undefined }), /supported choices: off, minimal, low, medium, high\./);
	assert.throws(() => resolveEffective("high", { ...model, thinkingLevelMap: { high: null, max: "max" } }), /Unsupported thinking high/);
	// A role default crosses a model without that exact level (GLM: medium → high; Synthetic GLM: low → high).
	const glm = { ...model, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } } as typeof model;
	assert.deepEqual(resolveEffective({ level: "medium", explicit: false }, glm), { effective: "high", verified: true });
	assert.deepEqual(resolveEffective({ level: "low", explicit: false }, glm), { effective: "low", verified: true });
	assert.deepEqual(resolveEffective({ level: "low", explicit: false }, { ...glm, thinkingLevelMap: { low: null, medium: null, high: "high", max: "max" } }), { effective: "high", verified: true });
	assert.throws(() => resolveEffective({ level: "medium", explicit: true }, glm), /Unsupported thinking medium/);
	assert.throws(() => resolveEffective({ level: "max", explicit: false }, { ...glm, thinkingLevelMap: { low: "low", high: "high", max: null } }), /Unsupported thinking max/);
	assert.equal(effortLabel({ requestedThinking: "xhigh" }), "xhigh→unknown");
	assert.equal(effortLabel({ requestedThinking: "max", thinking: "max" }), "max");
});

test("roster entries without thinking default to the role floor", async t => {
	const { calls, registry } = thinkingFixture(t);
	for (const [name, expected] of [["scout", "low"], ["reviewer", "high"]] as const) {
		const result = await runWorker({ ...agent, name, thinking: undefined }, "test", { registry, fallbackModel: undefined });
		assert.equal(result.status, "ok");
		assert.deepEqual([result.requestedThinking, result.thinking, calls.at(-1)!.thinking], [expected, expected, expected]);
	}
});

test("unsupported SDK efforts make zero inference calls and report supported choices", async t => {
	const { calls, registry } = thinkingFixture(t, (p, id) => ({ ...thinkingModel(p, id), reasoning: false }));
	for (const thinking of [undefined, "high", "xhigh", "max"]) {
		const result = await runWorker(agent, "test", { registry, fallbackModel: undefined, thinking });
		assert.equal(result.status, "error");
		assert.equal(result.thinking, "unknown");
		assert.equal(result.requestedThinking, thinking ?? "high");
		assert.match(result.error!, /supported choices: off/);
	}
	assert.equal(calls.length, 0);
});

test("legacy floor warns once and every explicit fallback retains the exact effort", async t => {
	const { calls, registry } = thinkingFixture(t, (p, id) => {
		const model = thinkingModel(p, id);
		return p === "anthropic" ? { ...model, thinkingLevelMap: { xhigh: null, max: "max" } } : model;
	});
	const warnings: string[] = [];
	const floored = await runWorker(agent, "test", { registry, fallbackModel: undefined, onWarning: w => warnings.push(w) });
	assert.equal(floored.thinking, "high");
	assert.equal(warnings.filter(w => w.includes("raised to high")).length, 1);
	const live: string[] = [];
	const result = await runWorker(agent, "test", { registry, fallbackModel: undefined, modelSpec: "anthropic/claude-opus-5-5", thinking: "xhigh", onThinking: level => live.push(level) });
	assert.deepEqual(live, ["xhigh"]);
	assert.equal(result.status, "ok");
	assert.equal(result.model, "openai-codex/gpt-6-astra");
	assert.equal(result.requestedThinking, "xhigh");
	assert.equal(result.thinking, "xhigh");
	assert.match(result.failedAttempts!.join("\n"), /Unsupported thinking xhigh/);
	assert.deepEqual(calls.map(c => c.thinking), ["high", "xhigh"]);
	assert.ok(!calls.some(c => c.spec.startsWith("anthropic")));
});

test("explicit effort also survives provider failures and workflow last resorts", async t => {
	const { calls, registry } = thinkingFixture(t, thinkingModel, spec => spec === "fixture/last" ? "done" : "");
	const result = await runWorker(agent, "test", { registry, fallbackModel: undefined, modelSpec: "anthropic/claude-opus-5-5", thinking: "max", fallbackModels: ["fixture/last"] });
	assert.equal(result.status, "ok");
	assert.equal(result.model, "fixture/last");
	assert.equal(calls.length, 4);
	assert.ok(calls.every(c => c.thinking === "max"));
});

test("child preflight blocks unsupported effort before spawning; fallback argv and message evidence stay distinct", async t => {
	const root = process.env.PI_CODING_AGENT_DIR!;
	const bin = path.join(root, "thinking-fake-pi");
	const previous = process.env.PI_DISPATCH_PI_BIN;
	t.after(() => { if (previous === undefined) delete process.env.PI_DISPATCH_PI_BIN; else process.env.PI_DISPATCH_PI_BIN = previous; });
	fs.writeFileSync(bin, `#!/usr/bin/env node
const args=process.argv.slice(2);
console.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text',text:JSON.stringify(args)}], thinkingLevel:'xhigh', providerThinkingLevel:'native-extra', stopReason:'stop'}}));
`, { mode: 0o700 });
	process.env.PI_DISPATCH_PI_BIN = bin;
	const { registry } = thinkingFixture(t, (p, id) => ({ ...thinkingModel(p, id), reasoning: p !== "anthropic" }));
	const starts: string[] = [];
	const live: string[] = [];
	const result = await runWorkerProc(agent, "test", { cwd: root, registry, modelOverride: "anthropic/claude-opus-5-5", thinking: "xhigh", onAttempt: model => starts.push(model), onThinking: level => live.push(level) });
	assert.deepEqual(starts, ["openai-codex/gpt-6-astra"]);
	assert.deepEqual(live, ["xhigh"]);
	assert.equal(result.status, "ok");
	assert.equal(result.thinking, "xhigh");
	assert.equal(result.providerThinkingLevel, "native-extra");
	const args: string[] = JSON.parse(result.text);
	for (const flag of ["--thinking", "--dispatch-thinking"]) assert.equal(args[args.indexOf(flag) + 1], "xhigh");
	assert.ok(args.some(arg => arg.endsWith("/thinking-guard.ts")));
	const noInference = await runWorkerProc(agent, "test", { cwd: root, registry: { find: () => ({ ...thinkingModel(), reasoning: false }) } as any, thinking: "high" });
	assert.equal(noInference.status, "error");
	assert.equal(noInference.attempts, 0);
	assert.equal(noInference.thinking, "unknown");
});

test("child guard loads through the actual SDK loader", async () => {
	const root = process.env.PI_CODING_AGENT_DIR!;
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(), noExtensions: true,
		additionalExtensionPaths: [path.resolve("src/thinking-guard.ts")], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions[0].handlers.get("before_provider_request")?.length, 1);
	assert.ok(loaded.extensions[0].flags.has("dispatch-thinking"));
});

for (const event of ["before_agent_start", "before_provider_request"]) {
	test(`child ${event} guard exits before inference instead of relying on swallowed hook errors`, () => {
		// Plain Node executes the extension callback, not Pi or an agent CLI.
		const script = `import guard from './src/thinking-guard.ts';
const handlers=new Map();
guard({registerFlag(){},getFlag:()=> 'xhigh',on:(name,fn)=>handlers.set(name,fn)});
handlers.get(${JSON.stringify(event)})({}, {model:{provider:'fixture',id:'arbitrary-name',reasoning:true,thinkingLevelMap:{xhigh:null,max:'max'}},thinkingLevel:'max'});
console.log('INFERENCE');`;
		const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
		assert.equal(run.status, 1);
		assert.match(run.stdout, /dispatch_thinking_error.*Unsupported thinking xhigh.*supported choices/);
		assert.doesNotMatch(run.stdout, /INFERENCE/);
	});
}

test("real SDK hook path refuses clamped effort and later drift before a mocked provider sends", () => {
 for (const drift of [false, true]) {
  // No Pi CLI or live provider: exercise session hooks under a plain Node SDK host.
  const script = `
import {createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {thinkingModel} from './tests/thinking-fixture.ts';
const root=process.env.PI_CODING_AGENT_DIR;
const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:SettingsManager.inMemory(),noExtensions:true,
 additionalExtensionPaths:[process.cwd()+'/src/thinking-guard.ts'],noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true});
await loader.reload();
loader.getExtensions().runtime.flagValues.set('dispatch-thinking','xhigh');
const model={...thinkingModel(), reasoning:${drift}};
ModelRuntime.prototype.hasConfiguredAuth=()=>true;
ModelRuntime.prototype.streamSimple=function(model,context,options){
 const stream=createAssistantMessageEventStream();
 (async()=>{
  session.setThinkingLevel('off');
  await options.onPayload({});
  console.log('PROVIDER_SENT');
 })();
 return stream;
};
const {session}=await createAgentSession({cwd:root,model,thinkingLevel:'xhigh',noTools:'all',resourceLoader:loader,
 settingsManager:SettingsManager.inMemory(),sessionManager:SessionManager.inMemory(root)});
await session.prompt('fixture');
`;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /dispatch_thinking_error/);
  assert.match(run.stdout, drift ? /Thinking changed|thinking changed/ : /Unsupported thinking/);
  assert.doesNotMatch(run.stdout, /PROVIDER_SENT/);
 }
});


test("roster floors legacy effort once and fallback cannot replace the resolved request", async t => {
	const { calls, registry } = thinkingFixture(t, thinkingModel, spec => spec.endsWith("/alternate") ? "done" : "");
	for (const thinking of [undefined, "xhigh"] as const) {
		calls.length = 0;
		const warnings: string[] = [];
		const result = await runWorker({ ...agent, name: "thinking-roster" }, "test", { registry, fallbackModel: undefined, thinking, onWarning: w => warnings.push(w) });
		assert.equal(result.status, "ok");
		assert.equal(result.thinking, thinking ?? "high");
		assert.ok(calls.every(c => c.thinking === (thinking ?? "high")));
		assert.equal(warnings.filter(w => w.includes("raised to high")).length, thinking ? 0 : 1);
	}
});

test("virtual catalog models are refused before any in-process provider call", async t => {
	const virtual = () => ({ ...thinkingModel(), api: "pi-virtual" });
	assert.throws(() => resolveEffective("high", virtual()), /Virtual model.*physical model/);
	const { calls, registry } = thinkingFixture(t, virtual);
	const result = await runWorker(agent, "test", { registry, fallbackModel: undefined, thinking: "max" });
	assert.equal(result.status, "error");
	assert.equal(calls.length, 0);
	assert.match(effortSummary([result]), /Virtual model/);
});

for (const mode of ["high", "virtual", "late", "write-error", "missing-flag"]) {
	test(`child guard evidence: ${mode}`, () => {
		const script = `import guard from './src/thinking-guard.ts';
import fs from 'node:fs';
const handlers=new Map();
const mode=${JSON.stringify(mode)};
guard({registerFlag(){},getFlag:()=>mode==='missing-flag'?undefined:'high',on:(name,fn)=>handlers.set(name,fn)});
const ctx={model:{provider:'fixture',id:'model',api:'openai-completions',reasoning:true},thinkingLevel:'high'};
if(mode==='virtual')ctx.model.api='pi-virtual';
if(mode==='late')handlers.get('before_provider_request')({},ctx);
if(mode==='late'||mode==='write-error')ctx.thinkingLevel='off';
if(mode==='write-error')fs.closeSync(1);
try{handlers.get('before_agent_start')({},ctx);}catch{console.error('SWALLOWED');}
console.error('PROVIDER_ALLOWED');`;
		const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
		assert.equal(run.status, mode === "high" ? 0 : 1, run.stderr);
		if (mode === "high") return assert.match(run.stderr, /PROVIDER_ALLOWED/);
		assert.doesNotMatch(run.stderr, /SWALLOWED|PROVIDER_ALLOWED/);
		if (mode === "write-error") return;
		const event = JSON.parse(run.stdout);
		assert.equal(event.type, "dispatch_thinking_error");
		assert.equal(event.preInference, mode !== "late");
	});
}

test('offline SDK session accepts exact high, but refuses a virtual selection before routing or sending', () => {
 for (const virtual of [false, true]) {
  const script = `
import {createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {thinkingModel} from './tests/thinking-fixture.ts';
const root=process.env.PI_CODING_AGENT_DIR;
const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:SettingsManager.inMemory(),noExtensions:true,
 additionalExtensionPaths:[process.cwd()+'/src/thinking-guard.ts'],noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true});
await loader.reload();
if(loader.getExtensions().errors.length)throw new Error('guard failed to load');
if(!loader.getExtensions().extensions[0].flags.has('dispatch-thinking'))throw new Error('flag not registered');
loader.getExtensions().runtime.flagValues.set('dispatch-thinking','high');
const model={...thinkingModel(), ...(${virtual}?{api:'pi-virtual'}:{})};
ModelRuntime.prototype.hasConfiguredAuth=()=>true;
ModelRuntime.prototype.streamSimple=function(model,context,options){
 const stream=createAssistantMessageEventStream();
 (async()=>{
  await options.onPayload({});
  console.log('PROVIDER_SENT:'+options.reasoning);
  const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'done'}],stopReason:'stop',timestamp:Date.now(),
   usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  stream.push({type:'done',reason:'stop',message});
 })();
 return stream;
};
const {session}=await createAgentSession({cwd:root,model,thinkingLevel:'high',noTools:'all',resourceLoader:loader,
 settingsManager:SettingsManager.inMemory(),sessionManager:SessionManager.inMemory(root)});
await session.prompt('fixture');
session.dispose();`;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, virtual ? 1 : 0, run.stderr);
  if (virtual) {
   assert.match(run.stdout, /dispatch_thinking_error.*preInference.*true.*Virtual model/);
   assert.doesNotMatch(run.stdout, /PROVIDER_SENT/);
  } else assert.match(run.stdout, /PROVIDER_SENT:high/);
 }
});


test("SDK startup flag validation rejects an unloaded guard", async () => {
	const root = process.env.PI_CODING_AGENT_DIR!;
	for (const loaded of [true, false]) {
		const services = await createAgentSessionServices({
			cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
			modelRuntime: { refresh: async () => undefined } as any,
			extensionFlagValues: new Map([["dispatch-thinking", "high"]]),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
				additionalExtensionPaths: loaded ? [path.resolve("src/thinking-guard.ts")] : [] },
		});
		if (loaded) {
			assert.deepEqual(services.diagnostics, []);
			assert.equal(services.resourceLoader.getExtensions().runtime.flagValues.get("dispatch-thinking"), "high");
		} else assert.ok(services.diagnostics.some(d => d.type === "error" && d.message.includes("--dispatch-thinking")));
	}
});
