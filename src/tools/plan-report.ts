import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateText } from "../worker.ts";

/** Keep complete reports outside the repository and beyond temporary-file cleanup. */
export async function savePlanReport(text: string) {
	const preview = truncateText(text);
	const directory = join(getAgentDir(), "pi-dispatch", "plans");
	const file = join(directory, `${randomUUID()}.md`);
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
		return {
			...preview,
			saved: true,
			text: `${preview.text}\n\nFull report saved to: ${file}${preview.truncated
				? "\nRead the complete file with offset/limit before using its contracts. Do not restart feature_plan to recover truncated text."
				: ""}`,
		};
	} catch {
		return {
			...preview,
			saved: false,
			text: `${preview.text}\n\nReport could not be saved. Full text remains in this tool result's details.items; recover it from the session before using truncated contracts. Do not restart feature_plan just to recover text.`,
		};
	}
}
