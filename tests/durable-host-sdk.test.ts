import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hook = path.join(repoRoot, "src/durable/host-sdk.mjs");
const sdkDir = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent");

// A script outside any node_modules tree stands in for a Git install made without peer/dev deps.
function runIsolated(t: test.TestContext, args: string[], env: Record<string, string>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-host-sdk-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const script = path.join(dir, "owner.mjs");
	fs.writeFileSync(script, 'import { parseFrontmatter, getAgentDir } from "@earendil-works/pi-coding-agent";\nconsole.log(typeof parseFrontmatter, typeof getAgentDir);\n');
	const { PI_DISPATCH_HOST_SDK: _, ...base } = process.env;
	return spawnSync(process.execPath, [...args, script], { cwd: dir, encoding: "utf8", env: { ...base, ...env } });
}

test("owner without the host hook cannot resolve the Pi SDK", (t) => {
	const result = runIsolated(t, [], {});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
});

test("host hook resolves the Pi SDK from PI_DISPATCH_HOST_SDK", (t) => {
	const result = runIsolated(t, ["--import", pathToFileURL(hook).href], { PI_DISPATCH_HOST_SDK: pathToFileURL(path.join(sdkDir, "dist", "index.js")).href });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "function function");
});
