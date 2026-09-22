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

test("cross-check model overrides are trimmed and blank overrides keep defaults", () => {
	assert.deepEqual(loadPair({
		DISPATCH_DIVERSE_0_MODEL: "  custom/family/model  ",
		DISPATCH_DIVERSE_1_MODEL: "  ",
	}), ["custom/family/model", "aperture/neuralwatt/kimi-k3"]);
	assert.deepEqual(loadPair({
		DISPATCH_DIVERSE_1_MODEL: " other/model ",
	}), ["aperture/neuralwatt/glm-5.3", "other/model"]);
});
