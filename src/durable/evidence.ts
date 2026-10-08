/**
 * Durable evidence of a pilot child that ran while its owner was gone.
 *
 * Two files in the attempt's session directory, both written by the child:
 * - `events.log`: the `--mode json` event stream. `agent_settled` is the
 *   completion marker the live owner also requires; `aborted: true` on it
 *   marks a cancelled run.
 * - `<timestamp>_<sessionId>.jsonl`: Pi's session file (SDK 1.0.4 format: a
 *   `session` header with `version: 3`, then entries; every assistant message
 *   is a `message` entry with `usage`). Spend and the final answer come from it.
 *
 * Anything missing, unreadable, or inconsistent between the two is ambiguous.
 */

import fs from "node:fs";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { PILOT_EVENTS_FILE, pricedUsage } from "../worker-proc.ts";

export type Evidence =
	| { readonly state: "ambiguous"; readonly reason: string }
	| { readonly state: "unsettled" }
	| { readonly state: "settled"; readonly spentUsd: number | null; readonly text: string; readonly problem: string | null };

type Part = { type?: string; text?: string };
type Message = { role?: string; content?: Part[] | string; usage?: Usage; stopReason?: string; errorMessage?: string };
type Line = Record<string, unknown> & { type?: string; id?: unknown; message?: Message };

/** JSON lines of a file; a torn final line is dropped, any other bad line makes the file unreadable. */
function jsonLines(file: string): Line[] | undefined {
	if (!fs.existsSync(file)) return undefined;
	const lines = fs.readFileSync(file, "utf8").split("\n");
	const parsed: Line[] = [];
	for (const [i, line] of lines.entries()) {
		if (!line.trim()) continue;
		try {
			parsed.push(JSON.parse(line) as Line);
		} catch {
			if (i < lines.length - 1) return undefined;
		}
	}
	return parsed;
}

function sessionFile(dir: string, sessionId: string): string | string[] {
	const suffix = `_${sessionId}.jsonl`;
	const files = fs.readdirSync(dir).filter((file) => file.endsWith(suffix));
	return files.length === 1 ? path.join(dir, files[0]) : files;
}

/** Priced completions are a lower bound even without settlement. Never add the two copies together. */
export function reportedEvidenceUsd(dir: string, sessionId: string): number {
	if (!fs.existsSync(dir)) return 0;
	const session = sessionFile(dir, sessionId);
	const files = [path.join(dir, PILOT_EVENTS_FILE), ...(typeof session === "string" ? [session] : [])];
	return Math.max(0, ...files.map((file) => {
		const entries = jsonLines(file);
		if (entries?.[0]?.type !== "session" || entries[0].id !== sessionId) return 0;
		const messages = entries.filter((e) => (e.type === "message_end" || e.type === "message") && e.message?.role === "assistant");
		return messages.reduce((sum, e) => sum + (pricedUsage(e.message?.usage) ? e.message!.usage!.cost.total : 0), 0);
	}));
}

const textOf = (message: Message) => typeof message.content === "string"
	? message.content
	: (message.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");

function finalProblem(message: Message | undefined): string | null {
	if (!message) return "worker produced no assistant message";
	if (message.stopReason === "error" || message.stopReason === "aborted") return message.errorMessage ?? `worker stopped: ${message.stopReason}`;
	if (Array.isArray(message.content) && message.content.some((p) => p.type === "toolCall")) return "worker ended on a tool call";
	return textOf(message).trim() ? null : "blank response from child pi";
}

/** Judge a child from its session directory. Never reads other paths. */
export function readEvidence(dir: string, sessionId: string): Evidence {
	const ambiguous = (reason: string): Evidence => ({ state: "ambiguous", reason });
	if (!fs.existsSync(dir)) return ambiguous(`session directory ${dir} is missing`);
	const events = jsonLines(path.join(dir, PILOT_EVENTS_FILE));
	if (!events) return ambiguous("worker event log is missing or unreadable");
	const header = events.find((e) => e.type === "session");
	if (header?.id !== sessionId) return ambiguous(`worker event log is not session ${sessionId}`);
	const settled = events.find((e) => e.type === "agent_settled");
	if (!settled) return { state: "unsettled" };
	const file = sessionFile(dir, sessionId);
	if (typeof file !== "string") return ambiguous(`expected one Pi session file for ${sessionId}, found ${file.length}`);
	const entries = jsonLines(file);
	const first = entries?.[0];
	if (!entries || first?.type !== "session" || first.id !== sessionId || first.version !== 3) return ambiguous("Pi session file is unreadable or has another header");
	const assistant = entries.filter((e) => e.type === "message" && e.message?.role === "assistant").map((e) => e.message!);
	const reported = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").length;
	if (assistant.length !== reported) return ambiguous(`session file has ${assistant.length} assistant messages, event log ${reported}`);
	const priced = assistant.length > 0 && assistant.every((m) => pricedUsage(m.usage));
	const spentUsd = priced ? assistant.reduce((sum, m) => sum + m.usage!.cost.total, 0) : null;
	const last = assistant.at(-1);
	return { state: "settled", spentUsd, text: last ? textOf(last) : "", problem: settled.aborted === true ? "worker run was aborted" : finalProblem(last) };
}
