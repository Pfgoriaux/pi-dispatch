import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { resolveDiff, registerPrReviewTool } from "../src/tools/pr-review.ts";
import { registerFeaturePlanTool } from "../src/tools/feature-plan.ts";
import { modelIdentity } from "../src/model-diversity.ts";
import type { WorkerResult } from "../src/types.ts";

function fixture(t: { after: (fn: () => void) => void }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-diff-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("rejects Git option injection before executing anything", async (t) => {
	const dir = fixture(t);
	const pi = {
		exec: async () => {
			throw new Error("must not execute");
		},
	} as unknown as ExtensionAPI;
	for (const arg of [
		"--output=/tmp/target..patch",
		"--stat",
		"HEAD\n--output=file",
	]) {
		await assert.rejects(
			resolveDiff(pi, arg, dir, dir),
			/expected a PR number or Git revision/,
		);
	}
});

test("Git failure is not reviewed as an empty diff", async (t) => {
	const dir = fixture(t);
	const pi = {
		exec: async () => ({
			code: 128,
			stdout: "",
			stderr: "bad revision",
			killed: false,
		}),
	} as unknown as ExtensionAPI;
	await assert.rejects(resolveDiff(pi, "bad...HEAD", dir, dir), /bad revision/);
});

test("GitHub diff uses requested cwd, checks failures, never uses undefined Git ref", async (t) => {
	const dir = fixture(t);
	let fail = false;
	const calls: string[][] = [];
	const pi = {
		exec: async (cmd: string, args: string[], options: { cwd?: string }) => {
			calls.push([cmd, ...args]);
			if (cmd === "bash")
				return { code: 0, stdout: "", stderr: "", killed: false };
			assert.equal(cmd, "gh");
			assert.equal(options.cwd, dir);
			return {
				code: fail ? 1 : 0,
				stdout: fail ? "" : "diff --git a/test b/test\n",
				stderr: fail ? "authentication failed" : "",
				killed: false,
			};
		},
	} as unknown as ExtensionAPI;
	const result = await resolveDiff(pi, "123", dir, dir);
	assert.equal(result.empty, false);
	assert.equal(calls.filter(([cmd]) => cmd === "git").length, 0);
	fail = true;
	await assert.rejects(
		resolveDiff(pi, "123", dir, dir),
		/authentication failed/,
	);
});

test("local diffs disable external drivers and mark genuine empty targets", async (t) => {
	const dir = fixture(t);
	const pi = {
		exec: async (cmd: string, args: string[]) => {
			assert.equal(cmd, "git");
			assert.ok(args.includes("--no-ext-diff"));
			assert.ok(args.includes("--no-textconv"));
			assert.equal(args.at(-1), "--");
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI;
	assert.equal((await resolveDiff(pi, "main...HEAD", dir, dir)).empty, true);
});

test("omitted fix reaches read-only diff resolution even in an untrusted dirty repo", async () => {
	let tool: any;
	const pi = {
		registerTool: (value: unknown) => {
			tool = value;
		},
		exec: async () => ({
			code: 128,
			stdout: "",
			stderr: "diff sentinel",
			killed: false,
		}),
	} as unknown as ExtensionAPI;
	registerPrReviewTool(pi);
	await assert.rejects(
		tool.execute(
			"test",
			{ pr: "missing...HEAD", herdr: false },
			undefined,
			undefined,
			{
				cwd: path.resolve(import.meta.dirname, ".."),
				isProjectTrusted: () => false,
			},
		),
		/diff sentinel/,
	);
});

test("workflow credit fallbacks never duplicate models within parallel phases", async (t) => {
	const previousHerdr = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	t.after(() => {
		if (previousHerdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdr;
	});
	let tool: any;
	const prompts: string[] = [];
	let failCouncil = false;
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown) => {
		prompts.push(JSON.stringify(context));
		const failed = model.provider !== "openai-codex" || (failCouncil && JSON.stringify(context).includes("Review your initial findings"));
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: failed ? [] : [{ type: "text", text: "No findings." }],
			stopReason: failed ? "error" : "stop", errorMessage: failed ? "402 insufficient credits" : undefined,
			timestamp: Date.now(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		if (failed) stream.push({ type: "error", reason: "error", error: message });
		else stream.push({ type: "done", reason: "stop", message });
		return stream;
	});
	const registry = {
		find: (provider: string, id: string) => ({
			provider, id, api: "openai-completions", name: id, reasoning: false, input: ["text"],
			contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}),
		getRegisteredNativeProvider: () => undefined,
		getApiKeyForProvider: async () => undefined,
	} as unknown as ModelRegistry;
	registerPrReviewTool({
		registerTool: (value: unknown) => { tool = value; },
		exec: async (cmd: string) => ({ code: cmd === "git" ? 0 : 1, stdout: cmd === "git" ? "diff --git a/test b/test\n" : "", stderr: "", killed: false }),
	} as unknown as ExtensionAPI);
	const result = await tool.execute("test", { pr: "main...HEAD", herdr: false }, undefined, undefined, {
		cwd: path.resolve(import.meta.dirname, ".."), isProjectTrusted: () => false, modelRegistry: registry,
	});
	assert.match(result.content[0].text, /# PR review/);
	assert.match(result.content[0].text, /No findings|Fix skipped/);
	const assertDistinct = (items: WorkerResult[]) => {
		const successful = items.filter(r => r.status === "ok");
		const identities = successful.map(r => modelIdentity(r.model!));
		assert.equal(new Set(identities).size, identities.length);
		assert.equal(successful.length, 2, "Astra and Sol succeed; duplicate fallback workers stop");
	};
	assertDistinct(result.details.items.slice(0, 6));
	assert.ok(result.details.items[0].attempts > 0, "security starts before other roles claim all its candidates");

	registerFeaturePlanTool({ registerTool: (value: unknown) => { tool = value; } } as unknown as ExtensionAPI);
	const plan = await tool.execute("test", { idea: "test distinct model fallback", herdr: false }, undefined, undefined, {
		cwd: path.resolve(import.meta.dirname, ".."), isProjectTrusted: () => false, modelRegistry: registry,
	});
	assert.equal(plan.details.items.length, 11);
	assertDistinct(plan.details.items.slice(0, 5));
	assertDistinct(plan.details.items.slice(5, 10));
	assert.ok(plan.details.items.slice(5, 10).filter((r: WorkerResult) => r.attempts === 0).every((r: WorkerResult) => r.error?.startsWith("Skipped:")));
	assert.match(plan.content[0].text, /actual model:/);

	failCouncil = true;
	const fallback = await tool.execute("test", { idea: "test retained scout attribution", herdr: false }, undefined, undefined, {
		cwd: path.resolve(import.meta.dirname, ".."), isProjectTrusted: () => false, modelRegistry: registry,
	});
	const labels = ["Opus 5.5", "Astra", "DeepSeek 4.1", "Kimi 3", "GLM 5.3"];
	fallback.details.items.slice(0, 5).forEach((scout: WorkerResult, i: number) => {
		if (scout.status !== "ok") return;
		assert.equal(fallback.details.items[5 + i].status, "error");
		assert.ok(fallback.content[0].text.includes(`## ${labels[i]} [actual model: ${scout.model}]`));
	});
});

test("PR fix schema advertises opt-in commits", () => {
	let tool: any;
	registerPrReviewTool({
		registerTool: (value: unknown) => {
			tool = value;
		},
	} as ExtensionAPI);
	assert.match(tool.parameters.properties.fix.description, /default false/);
});
