/**
 * Child-process worker runner (write tier).
 *
 * Each worker is a fresh `pi -p --no-session --mode json` process with the
 * agent's system prompt, tool allowlist, and cwd pointed at its git
 * worktree. stdout is a JSON event stream; only the FINAL (or partial, on
 * abort) assistant text is surfaced — the context firewall rules from the
 * SDK tier (worker.ts) apply exactly: no transcripts, no stderr dumps.
 *
 * Recursion backstop: all three workflow tools are excluded from the child.
 * With `PI_DISPATCH_DEPTH = parent + 1`, a depth above MAX_PROC_DEPTH is
 * refused outright.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { LINKUP_GUIDANCE, workerTools } from "./linkup.ts";
import { ToolHealth } from "./tool-health.ts";
import { withProviderFallbacks } from "./roster.ts";
import { dirtyLines } from "./worktree.ts";
import { stopWorker } from "./process-tree.ts";
import {
	THINKING_LEVELS,
	type AgentConfig,
	type WorkerResult,
} from "./types.ts";

const MAX_PROC_DEPTH = 2;

export interface RunWorkerProcOptions {
	/** Working directory for the child (the task's git worktree). */
	cwd: string;
	/** Write-tier tasks must commit all tracked/untracked edits before merging. */
	requireCleanWorktree?: boolean;
	signal?: AbortSignal;
	/** Called at tool boundaries so the TUI can update (never per-delta). */
	onBoundary?: () => void;
	/** Live worker activity for observers (Herdr panes); UI-only, throttled naturally by event rate. */
	onStream?: (line: string) => void;
	onWarning?: (warning: string) => void;
	onAttempt?: (model: string, thinking: string, attempt: number) => void;
	thinking?: string;
	/** Parent model as `provider/id`; used when the agent spec says "inherit". */
	model?: string;
	/** Per-task model override (tier-expanded `provider/id`); wins over agent frontmatter. */
	modelOverride?: string;
}

/**
 * Resolve how to invoke a fresh pi CLI.
 *
 * Resolution order (fail later, not misbehave):
 * 1. `PI_DISPATCH_PI_BIN` — explicit operator override, always wins.
 * 2. `process.argv[1]` — the CLI entry script of the pi process hosting
 *    this extension, paired with its runtime (`process.execPath`). Best
 *    guess when argv[1] is really pi's entry; trades accuracy for fragility:
 *    if the extension is loaded from a different process layout (embedded
 *    SDK host, wrapper script) argv[1] is NOT pi and the child misfires.
 * 3. Bare `"pi"` from PATH — last resort.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const explicit = process.env.PI_DISPATCH_PI_BIN;
	if (explicit) {
		return { command: explicit, args };
	}
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

interface ContentPart {
	type: string;
	text?: string;
}

interface ChildMessage {
	role: string;
	content?: ContentPart[];
	usage?: Usage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** Last assistant message with text content and no tool calls. */
function finalAssistantText(messages: ChildMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const parts = msg.content ?? [];
		if (parts.some((p) => p.type === "toolCall")) continue;
		const text = parts
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
		if (text.trim()) return text;
	}
	return "";
}

/** Sum usage across assistant messages (usage is per-message, not cumulative). */
function sumUsage(messages: ChildMessage[]): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const message of messages) {
		if (message.role !== "assistant" || !message.usage) continue;
		total.input += message.usage.input ?? 0;
		total.output += message.usage.output ?? 0;
		total.cacheRead += message.usage.cacheRead ?? 0;
		total.cacheWrite += message.usage.cacheWrite ?? 0;
		total.totalTokens += message.usage.totalTokens ?? 0;
		total.cost.input += message.usage.cost?.input ?? 0;
		total.cost.output += message.usage.cost?.output ?? 0;
		total.cost.cacheRead += message.usage.cost?.cacheRead ?? 0;
		total.cost.cacheWrite += message.usage.cost?.cacheWrite ?? 0;
		total.cost.total += message.usage.cost?.total ?? 0;
	}
	return total;
}

export async function runWorkerProc(
	agent: AgentConfig,
	task: string,
	options: RunWorkerProcOptions,
): Promise<WorkerResult> {
	const started = Date.now();
	const spec = options.modelOverride?.trim() || agent.model;
	const model = spec && spec !== "inherit" ? spec : options.model;
	if (!model) return runOneProc(agent, task, options);
	const thinking = options.thinking && THINKING_LEVELS.has(options.thinking)
		? options.thinking : (agent.thinking ?? "off");
	const candidates = withProviderFallbacks([{
		modelSpec: model, thinking,
		entry: { provider: "", model, thinking, weight: 1 },
	}]);
	const attempts: WorkerResult[] = [];
	let result!: WorkerResult;
	for (const candidate of candidates) {
		if (options.signal?.aborted) {
			result = { agent: agent.name, task, status: "aborted", text: "", error: "Aborted before next attempt", ms: 0, attempts: attempts.length };
			break;
		}
		let toolsStarted = false;
		result = await runOneProc(agent, task, {
			...options,
			modelOverride: candidate.modelSpec,
			thinking: candidate.thinking,
			onAttempt: (selected, effort) => options.onAttempt?.(selected, effort, attempts.length + 1),
			onBoundary: () => { toolsStarted = true; options.onBoundary?.(); },
		});
		attempts.push(result);
		if (options.signal?.aborted) result = { ...result, status: "aborted" };
		// A fresh process cannot safely replay a writer after tools may have changed files.
		if (result.status !== "error" || toolsStarted) break;
	}
	return {
		...result,
		attempts: attempts.length,
		usage: sumUsage(attempts.map(attempt => ({ role: "assistant", usage: attempt.usage }))),
		ms: Date.now() - started,
	};
}

async function runOneProc(
	agent: AgentConfig,
	task: string,
	options: RunWorkerProcOptions,
): Promise<WorkerResult> {
	const started = Date.now();
	const base = { agent: agent.name, task, ms: 0, attempts: 1 };
	const fail = (
		status: WorkerResult["status"],
		error: string,
	): WorkerResult => ({
		...base,
		status,
		text: "",
		error,
		ms: Date.now() - started,
	});

	if (options.signal?.aborted) return fail("aborted", "Aborted before start");

	// Depth backstop for dispatch-in-dispatch via child processes.
	const parentDepth =
		Number.parseInt(process.env.PI_DISPATCH_DEPTH ?? "0", 10) || 0;
	const childDepth = parentDepth + 1;
	if (childDepth > MAX_PROC_DEPTH) {
		return fail(
			"error",
			`dispatch: write-tier child process depth limit (${MAX_PROC_DEPTH}) exceeded`,
		);
	}

	const web = workerTools(agent.tools);
	if (web.warning) options.onWarning?.(web.warning);
	const args: string[] = ["-p", "--no-session", "--mode", "json"];
	for (const entry of web.extensionPaths) args.push("--extension", entry);
	if (web.tools.length > 0) {
		args.push("--tools", web.tools.join(","));
	} else {
		args.push("--no-tools");
	}
	// Recursion backstop: the child must never be able to dispatch.
	args.push("--exclude-tools", "dispatch,pr_review,feature_plan");
	// Same "inherit" semantics as resolveWorkerModel (model.ts): a literal
	// "inherit" (or empty) spec means "use the parent's model". The raw
	// string must never reach the child CLI as --model (pi exits 1 with
	// `Model "inherit" not found` before making any API call).
	const spec = options.modelOverride?.trim() || agent.model;
	const model = spec && spec !== "inherit" ? spec : options.model;
	const thinking =
		options.thinking && THINKING_LEVELS.has(options.thinking)
			? options.thinking
			: (agent.thinking ?? "off");
	if (model) args.push("--model", model);
	args.push("--thinking", thinking);
	options.onAttempt?.(model ?? "child default", thinking, 1);
	const systemPrompt =
		`${agent.systemPrompt.trim() || `You are ${agent.name}. ${agent.description}`}\n\n${web.warning ? "Linkup web tools are unavailable in this worker. Do not claim to have searched the web." : LINKUP_GUIDANCE}`;
	// `--` ends option parsing: `task` is model-controlled text, so without
	// this separator a task beginning with "-"/"--" would be parsed by the
	// child pi CLI as a flag (in-context injection rewriting child flags).
	args.push("--system-prompt", systemPrompt, "--", task);

	// Streamed state (the only things that ever cross back to the parent).
	const endedMessages: ChildMessage[] = [];
	let finalText = "";
	let finalUsage: Usage | undefined;
	let streamedText = ""; // accumulates ALL assistant text deltas across every
	// assistant message in the session (multi-message) — a partial-signal used
	// only when the child is killed before agent_end, never a final answer.
	let lastModel: string | undefined;
	let lastError: { stopReason?: string; errorMessage?: string } | undefined;

	const toolHealth = new ToolHealth(web.tools);
	let buffer = "";
	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: Record<string, unknown> & { type?: string };
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		switch (event.type) {
			case "message_start":
			case "message_end": {
				const message = event.message as ChildMessage | undefined;
				if (message && event.type === "message_end") {
					endedMessages.push(message);
					if (message.role === "assistant") {
						if (message.model) lastModel = message.model;
						if (message.stopReason || message.errorMessage) {
							lastError = {
								stopReason: message.stopReason,
								errorMessage: message.errorMessage,
							};
						}
						options.onStream?.(
							`assistant message completed · ${message.model ?? "worker"}`,
						);
					}
				}
				break;
			}
			case "message_update": {
				const ame = event.assistantMessageEvent as
					| { type?: string; contentIndex?: number; delta?: string }
					| undefined;
				if (ame?.type === "text_delta" && typeof ame.delta === "string") {
					streamedText += ame.delta;
				}
				break;
			}
			case "tool_execution_start":
			case "tool_execution_end":
				// Map child tool boundaries to the parent's throttled UI updates.
				options.onBoundary?.();
				options.onStream?.(toolHealth.format({
					type: event.type,
					toolName: typeof event.toolName === "string" ? event.toolName : "",
					isError: event.isError === true,
				}));
				break;
			case "agent_end": {
				// Authoritative final state: last assistant message with text,
				// role=assistant, no toolCalls; usage from that same message.
				const messages = (event.messages as ChildMessage[] | undefined) ?? [];
				const idx = findFinalMessageIndex(messages);
				if (idx >= 0) {
					finalText = textOf(messages[idx]);
					finalUsage = messages[idx].usage;
				}
				break;
			}
		}
	};

	function findFinalMessageIndex(messages: ChildMessage[]): number {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role !== "assistant") continue;
			const parts = msg.content ?? [];
			if (parts.some((p) => p.type === "toolCall")) continue;
			if (parts.some((p) => p.type === "text" && (p.text ?? "").trim()))
				return i;
		}
		return -1;
	}

	function textOf(msg: ChildMessage): string {
		return (msg.content ?? [])
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
	}

	let wasAborted = false;
	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: options.cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		env: { ...process.env, PI_DISPATCH_DEPTH: String(childDepth) },
	});
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (data: string) => {
		buffer += data;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
	});
	// stderr is diagnostic only — it must never become model-visible text.
	proc.stderr.resume();

	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;
	let termination: Promise<void> | undefined;
	await new Promise<void>((resolve) => {
		proc.on("close", (code, signal) => {
			exitCode = code;
			exitSignal = signal;
			if (buffer.trim()) processLine(buffer);
			resolve();
		});
		proc.on("error", () => {
			exitCode = 1;
			resolve();
		});
		if (options.signal) {
			const kill = () => {
				wasAborted = true;
				termination ??= stopWorker(proc, options.onWarning);
			};
			if (options.signal.aborted) kill();
			else options.signal.addEventListener("abort", kill, { once: true });
			proc.on("close", () =>
				options.signal?.removeEventListener("abort", kill),
			);
		}
	});

	await termination;

	if (wasAborted || options.signal?.aborted || lastError?.stopReason === "aborted") {
		// Partial = whatever assistant text was streamed before the kill call.
		const partial =
			finalText || finalAssistantText(endedMessages) || streamedText;
		return {
			...base,
			status: "aborted",
			text: partial,
			model: model ?? lastModel,
			usage: sumUsage(endedMessages),
			ms: Date.now() - started,
		};
	}

	if (exitCode !== 0) {
		const why =
			lastError?.errorMessage ||
			(exitSignal ? `child pi terminated by ${exitSignal}` : undefined) ||
			(lastError?.stopReason && lastError.stopReason !== "end"
				? `child pi stopped: ${lastError.stopReason}`
				: `child pi exited with code ${exitCode}`);
		return {
			...base,
			status: "error",
			text: finalText || finalAssistantText(endedMessages),
			error: why,
			model: model ?? lastModel,
			usage: sumUsage(endedMessages),
			ms: Date.now() - started,
		};
	}

	const text = finalText || finalAssistantText(endedMessages);
	let worktreeError: string | undefined;
	if (options.requireCleanWorktree) {
		try {
			if ((await dirtyLines(options.cwd, false)).length > 0) {
				worktreeError = `Worker left uncommitted edits; worktree retained at ${options.cwd}`;
			}
		} catch {
			worktreeError = `Cannot verify committed edits; worktree retained at ${options.cwd}`;
		}
	}
	const failed = lastError?.stopReason === "error" || !text.trim() || !!worktreeError;
	return {
		...base,
		status: failed ? "error" : "ok",
		error: failed
			? (lastError?.errorMessage ?? worktreeError ?? "blank response from child pi")
			: undefined,
		text,
		model: model ?? lastModel,
		thinking,
		usage: endedMessages.length ? sumUsage(endedMessages) : finalUsage,
		ms: Date.now() - started,
	};
}
