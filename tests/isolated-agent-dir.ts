import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Keep mocked workers independent of the operator's quotas and rosters. */
export function isolateAgentDir(): void {
	const directory = mkdtempSync(join(tmpdir(), "dispatch-test-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const herdr = new Map(["HERDR_ENV", "HERDR_SOCKET_PATH"].map(key => [key, process.env[key]]));
	for (const key of herdr.keys()) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = directory;
	after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		for (const [key, value] of herdr) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(directory, { recursive: true, force: true });
	});
}
