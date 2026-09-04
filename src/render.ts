/**
 * Collapsed-line TUI rendering for the dispatch tool.
 *
 * Grouped rendering: header line (totals + cost), then one section per agent
 * type with one row per worker (model, elapsed, attempts) and a preview
 * line. Renders via the same thunk pattern the official example uses
 * (reuse lastComponent, mutate text).
 */

import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { DispatchDetails, WorkerResult } from "./types.ts";

function statusIcon(r: WorkerResult): string {
	if (r.status === "ok") return "✓";
	if (r.status === "aborted") return "◍";
	return "✗";
}

/** "provider/glm-5.3" or "aperture/neuralwatt/glm-5.3" → "glm-5.3". */
function shortModel(spec: string | undefined): string | undefined {
	if (!spec) return undefined;
	const parts = spec.split("/");
	return parts[parts.length - 1] || spec;
}

function formatSeconds(ms: number): string {
	return `${Math.round(ms / 100) / 10}s`;
}

function formatCost(items: WorkerResult[]): string | undefined {
	let total = 0;
	for (const r of items) total += r.usage?.cost?.total ?? 0;
	if (total <= 0) return undefined;
	return `$${total.toFixed(3)}`;
}

/** Group results by agent name, preserving first-seen order. */
function groupByAgent(items: WorkerResult[]): { agent: string; rows: WorkerResult[] }[] {
	const order: string[] = [];
	const map = new Map<string, WorkerResult[]>();
	for (const r of items) {
		const rows = map.get(r.agent);
		if (rows) rows.push(r);
		else {
			order.push(r.agent);
			map.set(r.agent, [r]);
		}
	}
	return order.map((agent) => ({ agent, rows: map.get(agent) ?? [] }));
}

/** One worker row: status icon · model · elapsed · (attempts when >1). */
function formatWorkerRow(
	r: WorkerResult,
	fg: (c: string, s: string) => string,
): string {
	const color =
		r.status === "ok" ? "success" : r.status === "aborted" ? "warning" : "error";
	let row = `  ${fg(color, statusIcon(r))} ${fg("accent", shortModel(r.model) ?? r.agent)}`;
	row += fg("dim", ` · ${formatSeconds(r.ms)}`);
	if (r.attempts > 1) {
		row += fg("warning", ` · ${r.attempts} attempts`);
	}
	return row;
}

function firstLine(text: string, maxLen = 100): string {
	const line = (text ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
	const clean = line.replace(/\s+/g, " ").trim();
	return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}

function formatResultLine(r: WorkerResult): string {
	const tail =
		r.status === "ok"
			? firstLine(r.text)
			: r.status === "aborted"
				? `aborted after ${r.ms}ms${r.text ? ` (partial: ${firstLine(r.text, 60)})` : ""}`
				: (r.error ?? "failed");
	return tail;
}

export function renderDispatchCall(
	args: Record<string, unknown>,
	theme: { fg: (c: string, s: string) => string; bold: (s: string) => string },
	context: { lastComponent?: unknown },
): Text {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const count =
		(Array.isArray(args.tasks) ? args.tasks.length : 0) ||
		(Array.isArray(args.chain) ? args.chain.length : 0) ||
		(args.agent ? 1 : 0);
	const mode = Array.isArray(args.tasks)
		? "parallel"
		: Array.isArray(args.chain)
			? "chain"
			: "single";
	let content = theme.fg("toolTitle", theme.bold("dispatch "));
	content += theme.fg("accent", `${mode} (${count}`);
	content += count === 1 ? " task)" : " tasks)";
	if (typeof args.task === "string" && args.task) {
		content += " " + theme.fg("dim", `"${firstLine(args.task as string, 60)}"`);
	}
	text.setText(content);
	return text;
}

export function renderDispatchResult(
	result: { details?: DispatchDetails },
	options: { expanded: boolean },
	theme: { fg: (c: string, s: string) => string; bold: (s: string) => string },
	context: { lastComponent?: unknown },
): Text {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const details = result.details;
	if (!details) {
		text.setText(theme.fg("muted", "dispatch: no details"));
		return text;
	}

	// Aggregator rows are fan-in bookkeeping, not task workers: shown as
	// groups for transparency but excluded from worker counts.
	const workers = details.items.filter((r) => r.agent !== "aggregator");
	const running = details.running === true;
	const total = details.total ?? workers.length;
	const ok = workers.filter((r) => r.status === "ok").length;
	const failed = workers.filter((r) => r.status === "error").length;
	const aborted = workers.filter((r) => r.status === "aborted").length;

	let content = "";
	if (!options.expanded) {
		const icon = running ? "⋯" : failed > 0 ? "✗" : aborted > 0 ? "◍" : "✓";
		const color = running ? "muted" : failed > 0 ? "error" : "success";
		const done = running ? workers.length : ok;
		content += theme.fg(
			color,
			`${icon} ${done}/${total} workers ${running ? "done so far" : "done"}`,
		);
		if (failed > 0) content += theme.fg("error", `, ${failed} failed`);
		if (aborted > 0) content += theme.fg("warning", `, ${aborted} aborted`);
		// Agent-type repartition — visible without expanding.
		const groups = groupByAgent(details.items);
		if (groups.length > 1 || (groups[0]?.rows.length ?? 0) > 1) {
			content +=
				" " +
				theme.fg(
					"dim",
					groups.map((g) => `${g.agent}×${g.rows.length}`).join(" "),
				);
		}
		if (running) {
			content += theme.fg("muted", " · running");
		} else if (details.aggregated) {
			content += theme.fg("accent", " · aggregated");
		}
		content += ` ${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`;
	} else {
		// Header: totals, aggregation, cost. In-flight updates (running) get a
		// progress header instead of a nonsensical "0 workers" summary.
		let header: string;
		if (running) {
			header =
				theme.fg("toolTitle", theme.bold(`dispatch ${details.mode}`)) +
				theme.fg("dim", ` — running · ${workers.length}/${total} done`);
		} else {
			header =
				`${workers.length} ${workers.length === 1 ? "worker" : "workers"}`;
			header += ` · ${ok} ok`;
			if (failed > 0) header += ` · ${failed} failed`;
			if (aborted > 0) header += ` · ${aborted} aborted`;
			if (details.aggregated) header += " · aggregated";
			const cost = formatCost(details.items);
			header =
				theme.fg("toolTitle", theme.bold(`dispatch ${details.mode}`)) +
				theme.fg("dim", ` — ${header}`) +
				(cost ? theme.fg("dim", ` · ${cost}`) : "");
		}
		content += header + "\n";

		// Chain mode: sequence matters — numbered steps, no grouping.
		if (details.mode === "chain") {
			for (let i = 0; i < details.items.length; i++) {
				const r = details.items[i];
				content += `${i + 1}. ${formatWorkerRow(r, theme.fg).trimStart()}\n`;
				content += `   ${theme.fg("text", formatResultLine(r))}\n`;
			}
		} else {
			for (const group of groupByAgent(details.items)) {
				content +=
				theme.bold(group.agent) +
				theme.fg("dim", ` ×${group.rows.length}`) + "\n";
				for (const r of group.rows) {
					content += formatWorkerRow(r, theme.fg) + "\n";
					content += `    ${theme.fg("text", formatResultLine(r))}\n`;
				}
			}
		}

		// Write-tier merge outcome (dropped before: merges were never rendered).
		if (details.merges) {
			if (details.merges.merged.length > 0) {
				content +=
					theme.fg("success", `merged · ${details.merges.merged.join(", ")}`) + "\n";
			}
			for (const f of details.merges.failed) {
				content +=
					theme.fg("error", `merge failed · ${f.branch}`) +
					theme.fg("dim", ` — ${firstLine(f.error ?? "", 80)}`) + "\n";
			}
		}

		if (details.truncated) {
			content += theme.fg("warning", "  [some worker output truncated]");
		}
		// trailing newline is added by the shell
		content = content.replace(/\n$/, "");
	}
	text.setText(content);
	return text;
}
