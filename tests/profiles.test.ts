import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// Import in a fresh process: profiles capture environment overrides at load time.
function loadPair(overrides: Record<string, string> = {}): string[] {
	const env = { ...process.env };
	delete env.DISPATCH_DIVERSE_0_MODEL;
	delete env.DISPATCH_DIVERSE_1_MODEL;
	const moduleUrl = new URL("../src/profiles.ts", import.meta.url).href;
	return JSON.parse(execFileSync(process.execPath, [
		"--import", "tsx", "--input-type=module", "-e",
		`import { DIVERSE_PAIR } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(DIVERSE_PAIR));`,
	], { env: { ...env, ...overrides }, encoding: "utf8" }));
}

test("cross-check defaults use Neuralwatt routes through Aperture", () => {
	assert.deepEqual(loadPair(), [
		"aperture/neuralwatt/glm-5.3",
		"aperture/neuralwatt/kimi-k3",
	]);
});

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

test("cross-check model overrides are trimmed and blank overrides keep defaults", () => {
	assert.deepEqual(loadPair({
		DISPATCH_DIVERSE_0_MODEL: "  custom/family/model  ",
		DISPATCH_DIVERSE_1_MODEL: "  ",
	}), ["custom/family/model", "aperture/neuralwatt/kimi-k3"]);
	assert.deepEqual(loadPair({
		DISPATCH_DIVERSE_1_MODEL: " other/model ",
	}), ["aperture/neuralwatt/glm-5.3", "other/model"]);
});
