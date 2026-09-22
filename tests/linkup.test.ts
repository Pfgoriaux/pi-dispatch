import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import {
	AgentSession, createAgentSession, DefaultResourceLoader,
	ModelRuntime, SessionManager, SettingsManager, type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { LINKUP_TOOLS, linkupExtensionPaths, requestedLinkupTools, workerTools } from "../src/linkup.ts";
import { runWorker } from "../src/worker.ts";
import { runWorkerProc } from "../src/worker-proc.ts";
import type { AgentConfig } from "../src/types.ts";

const names = ["linkup_web_search", "linkup_web_answer", "linkup_web_fetch"];
function fixture(root: string): string {
	const dir = path.join(root, "npm/node_modules/@aliou/pi-linkup");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@aliou/pi-linkup" }));
	for (const name of names) {
		const entry = path.join(dir, `src/extensions/${name.replace("linkup_", "").replaceAll("_", "-")}/index.ts`);
		fs.mkdirSync(path.dirname(entry), { recursive: true });
		fs.writeFileSync(entry, `export default function(pi) {
			pi.registerTool({ name: ${JSON.stringify(name)}, label: "fixture", description: "fixture",
				parameters: { type: "object", properties: {} },
				execute: async (_id, _params, signal) => ({ content: [{type: "text", text: "fixture-only"}], details: { signal } }) });
		}`);
	}
	return dir;
}

test("Linkup loading is explicit, deduplicated and limited to named entrypoints", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-linkup-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const dir = fixture(root);
	const options = { agentDir: root, env: { LINKUP_API_KEY: "fixture-not-a-key" } };
	assert.deepEqual(linkupExtensionPaths([], { env: {} }), []);
	assert.deepEqual(linkupExtensionPaths(["read", "dispatch", "linkup_untrusted"], { env: {} }), []);
	assert.deepEqual(requestedLinkupTools([...names, ...names]), names);
	assert.deepEqual(linkupExtensionPaths(["read", names[0], names[0]], options), [path.join(dir, "src/extensions/web-search/index.ts")]);
	assert.equal(linkupExtensionPaths(names, options).length, 3);
	assert.deepEqual(linkupExtensionPaths(names, { env: { ...options.env, DISPATCH_LINKUP_PACKAGE_DIR: dir } }), linkupExtensionPaths(names, options));
	assert.throws(() => linkupExtensionPaths(names, { agentDir: root, env: {} }), /LINKUP_API_KEY/);
	assert.throws(() => linkupExtensionPaths(names, { env: { ...options.env, DISPATCH_LINKUP_PACKAGE_DIR: "relative" } }), /absolute/);
	fs.writeFileSync(path.join(dir, "package.json"), '{"name":"unrelated"}');
	assert.throws(() => linkupExtensionPaths(names, options), /missing or incompatible/);
	fs.writeFileSync(path.join(dir, "package.json"), "invalid JSON");
	assert.throws(() => linkupExtensionPaths(names, options), /missing or incompatible/);
	fs.writeFileSync(path.join(dir, "package.json"), '{"name":"@aliou/pi-linkup"}');
	fs.unlinkSync(path.join(dir, "src/extensions/web-fetch/index.ts"));
	assert.throws(() => linkupExtensionPaths(names, options), /missing or incompatible/);
});

test("headless workers load only explicit extensions, restrict tools and forward abort signals", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-linkup-sdk-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fixture(root);
	const discovered = path.join(root, "extensions/should-not-load.ts");
	fs.mkdirSync(path.dirname(discovered), { recursive: true });
	fs.writeFileSync(discovered, 'throw new Error("Unrelated extension must not load")');
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: linkupExtensionPaths(names, { agentDir: root, env: { LINKUP_API_KEY: "fixture-not-a-key" } }),
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.equal(loader.getExtensions().extensions.length, 3);
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	const { session } = await createAgentSession({
		cwd: root, agentDir: root, resourceLoader: loader, settingsManager,
		sessionManager: SessionManager.inMemory(root), modelRuntime, tools: [names[0]],
	});
	t.after(() => session.dispose());
	assert.deepEqual(session.getActiveToolNames(), [names[0]]);
	const tool = session.agent.state.tools.find((tool) => tool.name === names[0])!;
	const controller = new AbortController();
	const result = await tool.execute("fixture-call", {}, controller.signal, undefined);
	assert.deepEqual(result.content, [{ type: "text", text: "fixture-only" }]);
	assert.equal((result.details as { signal: AbortSignal }).signal, controller.signal);
});

test("ordinary and locally tool-less workers get Linkup automatically; broken registration never prompts", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-linkup-worker-"));
	const dir = fixture(root);
	const previousKey = process.env.LINKUP_API_KEY;
	const previousDir = process.env.DISPATCH_LINKUP_PACKAGE_DIR;
	process.env.LINKUP_API_KEY = "fixture-not-a-key";
	process.env.DISPATCH_LINKUP_PACKAGE_DIR = dir;
	t.after(() => {
		if (previousKey === undefined) delete process.env.LINKUP_API_KEY;
		else process.env.LINKUP_API_KEY = previousKey;
		if (previousDir === undefined) delete process.env.DISPATCH_LINKUP_PACKAGE_DIR;
		else process.env.DISPATCH_LINKUP_PACKAGE_DIR = previousDir;
		fs.rmSync(root, { recursive: true, force: true });
	});
	let prompts = 0;
	let localTools = ["read"];
	t.mock.method(AgentSession.prototype, "prompt", async function (this: AgentSession) {
		prompts++;
		assert.deepEqual(this.getActiveToolNames(), [...localTools, ...LINKUP_TOOLS]);
	});
	t.mock.method(AgentSession.prototype, "getLastAssistantText", () => "fixture success");
	const model = { provider: "linkup-fixture", id: "test" } as Model<Api>;
	const registry = {
		find: () => model, getRegisteredNativeProvider: () => undefined,
		getApiKeyForProvider: async () => undefined,
	} as unknown as ModelRegistry;
	const agent: AgentConfig = {
		name: "scout", description: "fixture", tools: ["read"],
		model: "linkup-fixture/test", systemPrompt: "fixture", source: "bundled", filePath: "fixture",
	};
	const options = { registry, fallbackModel: undefined, cwd: root, modelSpec: "linkup-fixture/test" };
	const result = await runWorker(agent, "test", options);
	assert.equal(result.status, "ok", result.error);
	assert.equal(result.text, "fixture success");
	assert.equal(prompts, 1);
	localTools = [];
	assert.equal((await runWorker({ ...agent, tools: [] }, "test", options)).status, "ok");
	assert.equal(prompts, 2);

	// The write tier receives the same shared web tools without running real Pi.
	const bin = path.join(root, "fake-pi");
	fs.writeFileSync(bin, `#!/usr/bin/env node
console.log(JSON.stringify({type: "message_end", message: {role: "assistant", content: [{type: "text", text: JSON.stringify(process.argv.slice(2))}], stopReason: "stop"}}));
`, { mode: 0o700 });
	const previousBin = process.env.PI_DISPATCH_PI_BIN;
	process.env.PI_DISPATCH_PI_BIN = bin;
	t.after(() => {
		if (previousBin === undefined) delete process.env.PI_DISPATCH_PI_BIN;
		else process.env.PI_DISPATCH_PI_BIN = previousBin;
	});
	const child = await runWorkerProc(agent, "test", { cwd: root });
	assert.equal(child.status, "ok", child.error);
	const args = JSON.parse(child.text) as string[];
	assert.deepEqual(args[args.indexOf("--tools") + 1].split(","), ["read", ...LINKUP_TOOLS]);
	assert.equal(args.filter((arg) => arg === "--extension").length, 3);
	assert.equal(args[args.indexOf("--exclude-tools") + 1], "dispatch,pr_review,feature_plan");

	// A fresh path avoids the SDK's extension cache, simulating incompatible registration.
	const missingDir = fixture(path.join(root, "missing"));
	fs.writeFileSync(path.join(missingDir, "src/extensions/web-search/index.ts"), "export default function() {}");
	process.env.DISPATCH_LINKUP_PACKAGE_DIR = missingDir;
	const failed = await runWorker(agent, "test", options);
	assert.equal(failed.status, "error");
	assert.match(failed.error!, /failed to register/);
	assert.equal(failed.attempts, 1);
	assert.equal(failed.model, "linkup-fixture/test");
	assert.equal(prompts, 2, "broken registered tools must never reach a model prompt");
});

test("missing Linkup leaves ordinary workers usable with a warning; pre-abort still wins", async (t) => {
	const previous = process.env.LINKUP_API_KEY;
	delete process.env.LINKUP_API_KEY;
	t.after(() => {
		if (previous === undefined) delete process.env.LINKUP_API_KEY;
		else process.env.LINKUP_API_KEY = previous;
	});
	const agent: AgentConfig = {
		name: "scout", description: "fixture", tools: ["read"], model: "fake/model",
		systemPrompt: "fixture", source: "bundled", filePath: "fixture",
	};
	const warnings: string[] = [];
	const controller = new AbortController();
	const options = {
		registry: { find: () => ({ provider: "fake", id: "model" }) } as unknown as ModelRegistry,
		fallbackModel: undefined, modelSpec: "fake/model",
		onWarning: (warning: string) => warnings.push(warning),
		onAttempt: () => controller.abort(), signal: controller.signal,
	};
	const setup = workerTools(["read", ...names], { env: {} });
	assert.deepEqual(setup.tools, ["read"]);
	assert.deepEqual(setup.extensionPaths, []);
	assert.match(setup.warning!, /LINKUP_API_KEY/);
	const result = await runWorker(agent, "test", options);
	assert.equal(result.status, "aborted");
	assert.equal(result.attempts, 1, "ordinary model selection still runs without Linkup");
	assert.match(warnings[0], /LINKUP_API_KEY/);
	warnings.length = 0;
	assert.equal((await runWorker(agent, "test", options)).status, "aborted");
	assert.deepEqual(warnings, [], "pre-abort does not attempt tool setup");
});
