import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateText } from "../worker.ts";

/** Keep complete reports outside the repository and beyond temporary-file cleanup. */
export async function savePlanReport(text: string, sessionFile?: string) {
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
		const recovery = sessionFile
			? `Read the full report from this session file's tool-result details.items after this call completes: ${sessionFile}`
			: "No persisted session path is available. Ask the user to recover the full report from the tool result metadata.";
		return {
			...preview,
			saved: false,
			text: `${preview.text}\n\nReport could not be saved.${preview.truncated
				? ` This preview is incomplete; do not execute it. ${recovery}`
				: " The complete report is shown above."}`,
		};
	}
}
