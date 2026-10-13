import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import dispatchExtension from "../src/index.ts";
import { findWorkerSession } from "../src/worker.ts";
import type { DispatchDetails } from "../src/types.ts";
import { thinkingFixture, thinkingModel } from "./thinking-fixture.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();
const exec = promisify(execFile);
function tools() {
	const tools = new Map<string, ToolDefinition>();
	dispatchExtension({ on() {}, registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		exec: async (cmd: string, args: string[], opts: any) => ({ ...await exec(cmd, args, opts), code: 0, killed: false }),
	} as unknown as ExtensionAPI);
	return tools;
}
const text = (result: any) => result.content.map((c: any) => c.text ?? "").join("\n");

for (const mode of ["tasks", "chain"] as const) {
	test(`dispatch ${mode} honors mixed efforts, tier independence and aggregator default`, async t => {
		const { registry, calls } = thinkingFixture(t);
		const ctx = { cwd: process.env.PI_CODING_AGENT_DIR!, isProjectTrusted: () => false, modelRegistry: registry };
		const result = await tools().get("dispatch")!.execute("test", { herdr: false, thinking: "xhigh", aggregate: true,
			[mode]: [{ agent: "scout", task: "one", model: "cheap", thinking: "max" },
				{ agent: "scout", task: "two {previous}", model: "precise", thinking: "high" },
				{ agent: "scout", task: "three" }],
		}, undefined, undefined, ctx as any);
		const items = (result.details as DispatchDetails).items;
		// Invocation xhigh does not reach scouts or the aggregator: they keep their role defaults.
		assert.deepEqual(items.map(r => r.requestedThinking), ["max", "high", "low", "medium"]);
		assert.deepEqual(items.map(r => r.thinking), ["max", "high", "low", "medium"]);
		assert.equal(calls.length, 4);
		assert.match(text(result), /Effort:.*scout max;.*scout high;.*scout low;.*aggregator medium/);
	});
}

test("resume retains requests through repeated override cycles and persists actual SDK thinking history", async t => {
	const { registry, calls } = thinkingFixture(t);
	const ctx = { cwd: process.env.PI_CODING_AGENT_DIR!, isProjectTrusted: () => false, modelRegistry: registry };
	const tool = tools().get("dispatch")!;
	const run = async (params: object) => {
		const result = await tool.execute("test", { ...params, herdr: false }, undefined, undefined, ctx as any);
		return (result.details as DispatchDetails).items[0];
	};
	const first = await run({ tasks: [{ agent: "scout", task: "remember", model: "fixture/original", thinking: "xhigh" }], persist: true });
	assert.equal(first.status, "ok");
	assert.equal(first.model, "fixture/original");
	const id = first.sessionId!;
	for (const [override, expected] of [[undefined, "xhigh"], [undefined, "xhigh"], ["max", "max"], [undefined, "max"], ["high", "high"], [undefined, "high"]]) {
		const resumed = await run({ resume: id, task: "continue", thinking: override });
		assert.notEqual(resumed.model, "fixture/original", "resume must use current routing, not pin the saved model");
		assert.equal(resumed.requestedThinking, expected);
		assert.equal(resumed.thinking, expected);
		assert.equal(findWorkerSession(id)!.requestedThinking, expected);
		assert.equal(calls.at(-1)!.thinking, expected);
	}
	const entries = fs.readFileSync(findWorkerSession(id)!.file, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.deepEqual(entries.filter(e => e.type === "thinking_level_change").map(e => e.thinkingLevel), ["xhigh", "max", "high"]);
});

for (const thinking of [undefined, "xhigh", "max"] as const) {
	test(`all workflow steps and the PR fix writer receive ${thinking ?? "high"}`, async t => {
		const { registry, calls } = thinkingFixture(t);
		const root = fs.mkdtempSync(path.join(process.env.PI_CODING_AGENT_DIR!, "workflow-"));
		const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
		git("init", "-b", "feat/fixture");
		git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
		git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", "/dev/null");
		fs.writeFileSync(path.join(root, "file"), "before"); git("add", "--", "file"); git("commit", "-m", "fixture");
		fs.writeFileSync(path.join(root, "file"), "after"); git("add", "--", "file"); git("commit", "-m", "fixture change");
		const child = path.join(process.env.PI_CODING_AGENT_DIR!, "workflow-child");
		fs.writeFileSync(child, `#!/usr/bin/env node
const a=process.argv.slice(2), thinking=a[a.indexOf('--thinking')+1];
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:thinking}],thinkingLevel:thinking,stopReason:'stop'}}));
`, { mode: 0o700 });
		const oldBin = process.env.PI_DISPATCH_PI_BIN;
		process.env.PI_DISPATCH_PI_BIN = child;
		t.after(() => { if (oldBin === undefined) delete process.env.PI_DISPATCH_PI_BIN; else process.env.PI_DISPATCH_PI_BIN = oldBin; });
		const ctx = { cwd: root, isProjectTrusted: () => true, modelRegistry: registry };
		const registered = tools();
		const inv = thinking ?? "high";
		// High-floor steps take the invocation choice; scout pre-mortems run low and the slop reviewer medium.
		const scenarios = [
			{ name: "feature_plan", params: { idea: "fixture" }, expected: [inv, "low", inv, inv] },
			{ name: "council", params: { question: "fixture" }, expected: [inv, inv, inv] },
			{ name: "pr_review", params: { pr: "HEAD^...HEAD", intent: "fixture", fix: true }, expected: [inv, inv, "low", "medium", inv, inv, inv] },
		];
		for (const { name, params, expected } of scenarios) {
			const result = await registered.get(name)!.execute("test", { ...params, thinking, herdr: false }, undefined, undefined, ctx as any);
			const items = (result.details as DispatchDetails).items;
			assert.equal(items.length, expected.length, text(result));
			assert.ok(items.every(r => r.status === "ok"), text(result));
			assert.deepEqual(items.map(r => r.requestedThinking), expected, name);
			assert.deepEqual(items.map(r => r.thinking), expected, name);
			assert.match(text(result), /[Ee]ffort:/);
		}
		assert.equal(calls.length, 13);
		// The pr_review fix writer is a child process, not an SDK call.
		assert.deepEqual(calls.map(c => c.thinking).sort(), scenarios.flatMap(s => s.expected).slice(0, -1).sort());
	});
}

test("invocation effort schemas accept high, xhigh, max; task items accept any level above their role floor", () => {
	const registered = tools();
	for (const name of ["dispatch", "feature_plan", "pr_review", "council"]) {
		const schema = registered.get(name)!.parameters as any;
		assert.deepEqual(schema.properties.thinking.anyOf.map((v: any) => v.const), ["high", "xhigh", "max"]);
	}
	for (const mode of ["tasks", "chain"]) {
		const schema = registered.get("dispatch")!.parameters as any;
		assert.deepEqual(schema.properties[mode].items.properties.thinking.anyOf.map((v: any) => v.const), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	}
});

test("task efforts below the role floor are refused before inference", async t => {
	const { registry, calls } = thinkingFixture(t);
	const ctx = { cwd: process.env.PI_CODING_AGENT_DIR!, isProjectTrusted: () => false, modelRegistry: registry };
	const result = await tools().get("dispatch")!.execute("test", { herdr: false, aggregate: false,
		tasks: [{ agent: "reviewer", task: "low review", thinking: "low" }, { agent: "scout", task: "off scout", thinking: "off" }],
	}, undefined, undefined, ctx as any);
	const items = (result.details as DispatchDetails).items;
	assert.deepEqual(items.map(r => r.status), ["error", "error"]);
	assert.match(items[0].error!, /below the reviewer floor high/);
	assert.match(items[1].error!, /below the scout floor low/);
	assert.equal(calls.length, 0);
});


test("successful fallback keeps unsupported choices visible after aggregation", async t => {
	const { registry, calls } = thinkingFixture(t, (p, id) => ({ ...thinkingModel(p, id), reasoning: p !== "anthropic" }));
	const ctx = { cwd: process.env.PI_CODING_AGENT_DIR!, isProjectTrusted: () => false, modelRegistry: registry };
	const result = await tools().get("dispatch")!.execute("test", { herdr: false, aggregate: true,
		tasks: [{ agent: "scout", task: "test", model: "anthropic/claude-opus-5-5", thinking: "xhigh" }],
	}, undefined, undefined, ctx as any);
	assert.ok((result.details as DispatchDetails).items.every(r => r.status === "ok"));
	assert.match(text(result), /Unsupported thinking xhigh.*supported choices: off/);
	assert.match(text(result), /Unsupported thinking medium for anthropic\/claude-sonnet-5-5/);
	assert.deepEqual(calls.map(c => c.thinking), ["xhigh", "medium"]);
	assert.ok(calls.every(c => !c.spec.startsWith("anthropic")));
});
