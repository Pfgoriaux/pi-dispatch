import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentSession, DefaultResourceLoader, SettingsManager, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runWorker } from "../src/worker.ts";

import { isolateAgentDir } from "./isolated-agent-dir.ts";

isolateAgentDir();

test("worker adapts the resolved model on every fallback without changing role or task", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-prompts-"));
  const previous = process.env.DISPATCH_LINKUP_PACKAGE_DIR;
  process.env.DISPATCH_LINKUP_PACKAGE_DIR = path.join(root, "missing");
  t.after(() => {
    if (previous === undefined) delete process.env.DISPATCH_LINKUP_PACKAGE_DIR;
    else process.env.DISPATCH_LINKUP_PACKAGE_DIR = previous;
    fs.rmSync(root, {recursive: true, force: true});
  });
  const seen: string[] = [];
  t.mock.method(AgentSession.prototype, "prompt", async function (this: AgentSession, task: string) {
    assert.equal(task, "Inspect only; do not edit.");
    seen.push(this.systemPrompt);
    assert.match(this.systemPrompt, /Read-only scout role/);
    assert.match(this.systemPrompt, /nobody can answer questions/);
    assert.match(this.systemPrompt, /requested output shape/);
    if (seen.length === 1) throw new Error("fixture provider failure");
  });
  t.mock.method(AgentSession.prototype, "getLastAssistantText", () => "fixture result");
  const registry = {
    find: (provider: string, id: string) => ({provider, id}) as Model<Api>,
    getRegisteredNativeProvider: () => undefined,
    getApiKeyForProvider: async () => undefined,
  } as unknown as ModelRegistry;
  // Resolved fallback deliberately differs in family to detect stale adaptation.
  registry.find = ((provider: string, id: string) => ({provider, id: id.includes("synthetic") ? "gpt-6-astra" : id})) as ModelRegistry["find"];
  const result = await runWorker({
    name: "scout", description: "fixture", tools: ["read"], model: "inherit",
    systemPrompt: "Read-only scout role", source: "bundled", filePath: "fixture",
  }, "Inspect only; do not edit.", {
    registry, fallbackModel: undefined, cwd: root,
    modelSpec: "aperture/neuralwatt/kimi-k3",
  });
  assert.equal(result.status, "ok", result.error);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /Model-specific guidance \(kimi-k3\)/);
  assert.match(seen[1], /Model-specific guidance \(gpt-6-astra\)/);
  assert.match(seen[1], /Do not stop at a plan when you can proceed/);
  assert.match(seen[1], /Complete required project checks/);
  assert.doesNotMatch(seen[1], /Model-specific guidance \(kimi-k3\)/);
});

test("built extension loads through Pi's actual resource loader without provider calls", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompts-loader-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = createRequire(import.meta.url).resolve("@pf/pi-model-prompts/extension");
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, additionalExtensionPaths: [entry],
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0].handlers.get("before_agent_start")?.length, 1);
});
