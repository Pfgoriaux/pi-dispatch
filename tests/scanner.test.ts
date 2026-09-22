import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findScanner } from "../src/tools/pr-review.ts";

test("review never selects a repository-controlled scanner, including symlinks", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-scanner-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const repo = path.join(root, "repo");
	const local = path.join(repo, ".deepsec", "deepsec");
	const external = path.join(root, "approved-scanner");
	fs.mkdirSync(path.dirname(local), { recursive: true });
	fs.writeFileSync(local, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	fs.writeFileSync(external, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const link = path.join(root, "global-looking-link");
	fs.symlinkSync(local, link);
	const resolve = (stdout: string, code = 0) => findScanner({
		exec: async (command, args, options) => {
			assert.equal(command, "bash");
			assert.deepEqual(args, ["-lc", "command -v deepsec"]);
			assert.equal(options?.cwd, repo);
			return { stdout, stderr: "", code, killed: false };
		},
	} as ExtensionAPI, repo);

	for (const candidate of [local, link, ".deepsec/deepsec", "deepsec", `${external}\n${local}`, repo]) {
		assert.equal(await resolve(candidate), undefined, candidate);
	}
	assert.equal(await resolve("", 1), undefined);
	assert.equal(await resolve(external + "\n"), fs.realpathSync(external));
	assert.equal(fs.readFileSync(local, "utf8"), "#!/bin/sh\nexit 1\n", "scanner was never executed");
});
