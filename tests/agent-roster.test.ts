import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import dispatchExtension from "../src/index.ts";

test("the live roster is advertised before dispatch, respects trust, and refreshes between turns", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-roster-"));
	const agentDir = path.join(root, "config");
	const cwd = path.join(root, "project");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	});
	const writeAgent = (dir: string, name: string, description: string) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\ntools: none\n---\nFixture instructions, not roster content.\n`);
	};
	writeAgent(path.join(agentDir, "agents"), "custom-analyst", "User analyst");
	writeAgent(path.join(cwd, ".pi/agents"), "researcher", "Project researcher");
	writeAgent(path.join(cwd, ".pi/agents"), "scout", "Project override");

	type Hook = (event: { systemPrompt: string }, ctx: ExtensionContext) => { systemPrompt: string };
	let beforeStart: Hook | undefined;
	const tools: ToolDefinition[] = [];
	dispatchExtension({
		on: (name: string, handler: Hook) => { if (name === "before_agent_start") beforeStart = handler; },
		registerTool: (tool: ToolDefinition) => tools.push(tool),
	} as unknown as ExtensionAPI);
	assert.ok(beforeStart, "registration must expose the roster before any tool call");
	const event = { systemPrompt: "Existing master instructions" };
	const context = (trusted: boolean) => ({ cwd, isProjectTrusted: () => trusted }) as ExtensionContext;
	const untrusted = beforeStart(event, context(false)).systemPrompt;
	assert.ok(untrusted.startsWith(event.systemPrompt));
	assert.match(untrusted, /- scout: .*\(bundled\)/);
	assert.match(untrusted, /- planner: /);
	assert.match(untrusted, /- custom-analyst: User analyst \(user\)/);
	assert.ok(!untrusted.includes("- researcher:"));
	assert.ok(!untrusted.includes("Fixture instructions"), "only metadata, never worker prompts");
	assert.match(untrusted, /never invent an agent name/);

	const trusted = beforeStart(event, context(true)).systemPrompt;
	assert.match(trusted, /- researcher: Project researcher \(project\)/);
	assert.match(trusted, /- scout: Project override \(project\)/);
	assert.equal(trusted.split("- scout:").length, 2, "overrides appear once");
	writeAgent(path.join(agentDir, "agents"), "new-role", "Added mid-session");
	const refreshed = beforeStart(event, context(false)).systemPrompt;
	assert.match(refreshed, /- new-role: Added mid-session \(user\)/);
	assert.equal(refreshed.split("## Dispatch agents").length, 2);
	assert.ok(!refreshed.includes("- researcher:"), "trust is checked each turn");

	const dispatch = tools.find((tool) => tool.name === "dispatch")!;
	assert.match(dispatch.description, /exact agent name.*roster/);
	await assert.rejects(
		() => dispatch.execute("fixture", { tasks: Array.from({ length: 5 }, () => ({ agent: "researcher", task: "fixture" })) }, undefined, undefined, context(false)),
		(error: Error) => {
			assert.match(error.message, /unknown agent\(s\): researcher\. Available agents:/);
			assert.ok(!error.message.includes("researcher, researcher"));
			assert.ok(error.message.includes("new-role"));
			return true;
		},
	);
});
