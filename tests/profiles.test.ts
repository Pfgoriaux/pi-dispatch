import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

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
