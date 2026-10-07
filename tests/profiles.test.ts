import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("tier defaults use Aperture for Neuralwatt and direct Pi for Codex", () => {
	const env = { ...process.env };
	for (const tier of ["CHEAP", "BALANCED", "PRECISE", "LONG"]) delete env[`DISPATCH_PROFILE_${tier}_MODEL`];
	const moduleUrl = new URL("../src/profiles.ts", import.meta.url).href;
	const profiles = JSON.parse(execFileSync(process.execPath, [
		"--import", "tsx", "--input-type=module", "-e",
		`import { PROFILES } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(PROFILES));`,
	], { env, encoding: "utf8" }));
	assert.equal(profiles.cheap.model, "aperture/neuralwatt/deepseek-v4.1-flash");
	assert.equal(profiles.balanced.model, "anthropic/claude-sonnet-5-5");
	assert.equal(profiles.long.model, "aperture/neuralwatt/kimi-k3");
	assert.equal(profiles.precise.model, "anthropic/claude-opus-5-5");
});

test("bundled roles resolve to Kimi for writing and precise for planning", t => {
	const dir = mkdtempSync(join(tmpdir(), "dispatch-role-defaults-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir };
	for (const tier of ["CHEAP", "BALANCED", "PRECISE", "LONG"]) delete env[`DISPATCH_PROFILE_${tier}_MODEL`];
	const moduleUrl = new URL("../src/agents.ts", import.meta.url).href;
	const roles = JSON.parse(execFileSync(process.execPath, [
		"--import", "tsx", "--input-type=module", "-e",
		`import { discoverAgents } from ${JSON.stringify(moduleUrl)};
		const { byName } = discoverAgents({ cwd: ${JSON.stringify(dir)}, isProjectTrusted: () => false });
		console.log(JSON.stringify(["writer", "planner"].map(name => {
			const { model, thinking } = byName.get(name); return { name, model, thinking };
		})));`,
	], { env, encoding: "utf8" }));
	assert.deepEqual(roles, [
		{ name: "writer", model: "aperture/neuralwatt/kimi-k3", thinking: "high" },
		{ name: "planner", model: "anthropic/claude-opus-5-5", thinking: "high" },
	]);
});
