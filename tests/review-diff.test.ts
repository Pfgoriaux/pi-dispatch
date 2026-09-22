import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { resolveDiff, registerPrReviewTool } from "../src/tools/pr-review.ts";

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

test("review reports actual fallback models and warns when cross-model diversity is lost", async (t) => {
	const previousHerdr = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	t.after(() => {
		if (previousHerdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdr;
	});
	let tool: any;
	const prompts: string[] = [];
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
	t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown) => {
		prompts.push(JSON.stringify(context));
		const failed = model.provider !== "openai-codex";
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
	assert.match(result.content[0].text, /both code reviewers used openai-codex\/gpt-5\.6-terra/);
	assert.match(result.content[0].text, /not a cross-model review/);
	assert.ok(prompts.some(prompt => prompt.includes("code review A [actual model: openai-codex/gpt-5.6-terra]")));
	assert.ok(prompts.some(prompt => prompt.includes("code review B [actual model: openai-codex/gpt-5.6-terra]")));
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
