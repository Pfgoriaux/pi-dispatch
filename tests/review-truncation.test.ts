import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { ModelRuntime, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { registerPrReviewTool } from "../src/tools/pr-review.ts";
import { isolateAgentDir } from "./isolated-agent-dir.ts";
import { PROFILES } from "../src/profiles.ts";

isolateAgentDir();

for (const scenario of ["short", "review-long", "final-long", "verify-failed", "errors-long", "truncated-fix", "fixed", "fix-uncommitted"]) {
	test(`PR review tracks truncation: ${scenario}`, async (t) => {
		const fix = ["truncated-fix", "fixed", "fix-uncommitted"].includes(scenario);
		let cwd = path.resolve(import.meta.dirname, "..");
		let initialHead = "";
		if (fix) {
			cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "review-truncated-fix-")));
			t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
			execFileSync("git", ["init", "-b", "feat/test", cwd]);
			execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
				"-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "fixture"]);
			const previous = process.env.PI_DISPATCH_PI_BIN;
			process.env.PI_DISPATCH_PI_BIN = path.join(cwd, "must-not-spawn");
			initialHead = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			if (scenario === "fixed" || scenario === "fix-uncommitted") {
				const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-fake-child-"));
				t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
				process.env.PI_DISPATCH_PI_BIN = path.join(binDir, "pi");
				fs.writeFileSync(process.env.PI_DISPATCH_PI_BIN, `#!/usr/bin/env node\nconst fs=require("fs"),cp=require("child_process"); fs.writeFileSync("fix.txt","ok"); ${scenario === "fixed" ? 'cp.execFileSync("git",["add","--","fix.txt"]); cp.execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","-m","fix"]);' : ""} console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"fixed"}],stopReason:"stop"}}));`, { mode: 0o700 });
			}
			t.after(() => {
				if (previous === undefined) delete process.env.PI_DISPATCH_PI_BIN;
				else process.env.PI_DISPATCH_PI_BIN = previous;
			});
		}
		t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
		t.mock.method(ModelRuntime.prototype, "streamSimple", (model: Model<Api>, context: unknown) => {
			const verify = JSON.stringify(context).includes("VERIFY and AGGREGATE");
			const failed = scenario === "errors-long" || (scenario === "verify-failed" && verify);
			const long = scenario === (verify ? "final-long" : "review-long") || scenario === "verify-failed" || scenario === "truncated-fix";
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: failed ? [] : [{ type: "text", text: long ? "界".repeat(10000) : "No findings." }],
				stopReason: failed ? "error" : "stop",
				errorMessage: failed ? "error".repeat(5000) : undefined,
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
				contextWindow: 64000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
			getRegisteredNativeProvider: () => undefined,
			getApiKeyForProvider: async () => undefined,
		} as unknown as ModelRegistry;
		let tool: any;
		registerPrReviewTool({
			registerTool: (value: unknown) => { tool = value; },
			exec: async () => ({ code: 0, stdout: "diff --git a/test b/test\n", stderr: "", killed: false }),
		} as unknown as ExtensionAPI);
		const result = await tool.execute("test", { pr: fix ? "HEAD" : "main...HEAD", fix, herdr: false }, undefined, undefined, {
			cwd, isProjectTrusted: () => fix, modelRegistry: registry,
		});
		assert.equal(result.details.truncated, !["short", "fixed", "fix-uncommitted"].includes(scenario));
		assert.ok(!result.content[0].text.includes("�"));
		if (scenario === "verify-failed") {
			for (const label of ["Correctness + security reviewer", "Correctness reviewer", "Pre-mortem", "Slop reviewer"])
				assert.ok(result.content[0].text.includes(`### ${label}`));
		}
		if (scenario === "errors-long") {
			assert.match(result.content[0].text, /Slop: docs rules/);
		} else if (scenario === "fix-uncommitted") {
			assert.equal(result.details.worktrees[0].status, "error");
			assert.match(result.content[0].text, /Worker left uncommitted edits/);
			assert.ok(fs.existsSync(result.details.worktrees[0].path));
		} else if (scenario === "fixed") {
			const entry = result.details.worktrees[0];
			assert.equal(entry.commits, 1);
			assert.equal(result.details.items.at(-1).model, PROFILES.long.model);
			assert.equal(entry.status, "ok");
			assert.ok(fs.existsSync(entry.path));
			assert.equal(execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), initialHead);
			assert.match(result.content[0].text, /Worktree branches \(not merged\)/);
		} else if (fix) {
			assert.match(result.content[0].text, /Fix skipped: review material was truncated/);
			assert.equal(result.details.items.length, 5, "no writer or merge step runs");
		} else {
			assert.match(result.content[0].text, /Fix skipped: fix=false/);
		}
	});
}
