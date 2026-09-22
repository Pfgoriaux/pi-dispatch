import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerPrReviewTool } from "../src/tools/pr-review.ts";
import { pinFixHead, assertFixHead } from "../src/tools/review-target.ts";

test("fixes require the reviewed head and refuse a moved checkout", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-review-head-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "commit.gpgsign", "false");
	git("config", "core.hooksPath", "/dev/null");
	git("commit", "--allow-empty", "-m", "base");
	const base = git("rev-parse", "HEAD");
	git("branch", "other");
	git("commit", "--allow-empty", "-m", "head");
	const head = git("rev-parse", "HEAD");
	const pi = { exec: async () => ({ code: 0, stdout: head, stderr: "", killed: false }) } as unknown as ExtensionAPI;
	assert.equal(await pinFixHead(pi, cwd, "HEAD~1...HEAD"), head);
	assert.equal(await pinFixHead(pi, cwd, "other"), head);
	assert.equal(await pinFixHead(pi, cwd, "42"), head);
	await assert.rejects(() => pinFixHead(pi, cwd, "HEAD...other"), /differs/);
	const differentPr = { exec: async () => ({ code: 0, stdout: base, stderr: "", killed: false }) } as unknown as ExtensionAPI;
	await assert.rejects(() => pinFixHead(differentPr, cwd, "42"), /differs/);
	await assert.rejects(() => pinFixHead(pi, cwd, "--output=oops"), /options/);
	// A PR can move between its identity lookup and gh pr diff. Refuse before
	// starting any reviewer, even though the local checkout itself stayed put.
	let tool: ToolDefinition | undefined;
	let views = 0;
	registerPrReviewTool({
		registerTool: (registered: ToolDefinition) => { tool = registered; },
		exec: async (command: string, args: string[]) => {
			if (command === "gh" && args[1] === "view") {
				return { code: 0, stdout: ++views === 1 ? head : base, stderr: "", killed: false };
			}
			return { code: 0, stdout: command === "gh" ? "diff --git a/sum.js b/sum.js\n" : "", stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI);
	await assert.rejects(() => tool!.execute("fixture", { pr: "42", fix: true, herdr: false }, undefined, undefined,
		{ cwd, isProjectTrusted: () => true } as ExtensionContext), /differs/);
	assert.equal(views, 2);

	git("commit", "--allow-empty", "-m", "concurrent change");
	await assert.rejects(() => assertFixHead(cwd, head), /differs/);
});
