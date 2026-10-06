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
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveChildModel } from "./child-model.ts";
import { workerTools } from "./linkup.ts";
import { workerSystemPrompt } from "./worker-prompt.ts";
import { ToolHealth } from "./tool-health.ts";
import { withProviderFallbacks } from "./roster.ts";
import { exhaustedQuotaReason, quotaCandidates } from "./quota.ts";
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
	/** Parent registry resolves bare IDs before the child can choose a provider. */
	registry?: ModelRegistry;
	/** Parent model as `provider/id`; used when the agent spec says "inherit". */
	model?: string;
	/** Per-task model override (tier-expanded `provider/id`); wins over agent frontmatter. */
	modelOverride?: string;
	/** Opt in for tier/workflow model choices, not explicit per-task pins. */
	steerByQuota?: boolean;
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
	if (options.signal?.aborted) {
		return { agent: agent.name, task, status: "aborted", text: "", error: "Aborted before model selection", ms: 0, attempts: 0 };
	}
	const spec = options.modelOverride?.trim() || agent.model;
	const selected = spec && spec !== "inherit" ? spec : options.model;
	const resolved = options.registry ? resolveChildModel(options.registry, selected) : undefined;
	const model = options.registry ? resolved && `${resolved.provider}/${resolved.id}` : selected;
	if (!model?.includes("/")) {
		return { agent: agent.name, task, status: "error", text: "", error: "Child workers require a resolved provider/model identity", ms: Date.now() - started, attempts: 0 };
	}
	const thinking = options.thinking && THINKING_LEVELS.has(options.thinking)
		? options.thinking : (agent.thinking ?? "off");
	let candidates = withProviderFallbacks([{
		modelSpec: model, thinking,
		entry: { provider: "", model, thinking, weight: 1 },
	}]);
	if (options.steerByQuota ?? (!options.modelOverride?.trim() && agent.quotaRouting === true)) {
		candidates = quotaCandidates(candidates, options.onWarning);
	}
	const attempts: WorkerResult[] = [];
	let result: WorkerResult = { agent: agent.name, task, status: "error", text: "", error: "No eligible model candidates", ms: 0, attempts: 0 };
	for (const candidate of candidates) {
		if (options.signal?.aborted) {
			result = { agent: agent.name, task, status: "aborted", text: "", error: "Aborted before next attempt", ms: 0, attempts: attempts.length };
			break;
		}
		if (options.registry && !resolveChildModel(options.registry, candidate.modelSpec)) {
			const reason = `No model available for candidate "${candidate.modelSpec}"`;
			options.onWarning?.(reason);
			if (attempts.length === 0) result = { ...result, error: reason };
			continue;
		}
		const quotaReason = exhaustedQuotaReason(candidate.modelSpec);
		if (quotaReason) {
			options.onWarning?.(quotaReason);
			if (attempts.length === 0) result = { ...result, error: quotaReason };
			continue;
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
		status: options.signal?.aborted ? "aborted" : result.status,
		attempts: attempts.length,
		usage: sumUsage(attempts.map(attempt => ({ role: "assistant", usage: attempt.usage }))),
		ms: Date.now() - started,
	};
}

/** Durable-pilot child. Unlike `runWorkerProc`, it never falls back, re-routes, or guesses the executable. */
export interface PilotProcOptions {
	cwd: string;
	/** Absolute Pi executable; `PI_DISPATCH_PI_BIN`, argv, and PATH are never consulted. */
	piExecutable: string;
	/** Arguments before Pi's own, e.g. the CLI script when `piExecutable` is Node. */
	piPrefixArgs?: readonly string[];
	/** Exact `provider/id`; tried once. */
	model: string;
	thinking: string;
	/** Passed as `--session-id`; the child's `session` header must echo it. */
	sessionId: string;
	/** Passed as `--session-dir`. The child's JSON event stream goes to `PILOT_EVENTS_FILE` inside it. */
	sessionDir: string;
	/** Called once with the spawned PID and its `ps` start identity. A rejection stops the child. */
	onSpawn: (pid: number, startIdentity: string) => Promise<void> | void;
	signal?: AbortSignal;
	requireCleanWorktree?: boolean;
	registry?: ModelRegistry;
	onStream?: (line: string) => void;
	onWarning?: (warning: string) => void;
}

export interface PilotProcResult extends WorkerResult {
	/** Recorded identity, or null when the child never got one. */
	spawned: { pid: number; startIdentity: string } | null;
	/** True once a child process was started. */
	launched: boolean;
	/** True when the child reported `agent_settled`; usage is complete only then. */
	settled: boolean;
	/** Every assistant completion supplied usable priced usage. */
	spendKnown: boolean;
}

/** Parent-session and coordinator-store variables a pilot child must not inherit. */
const PILOT_ENV_DENY = new Set(["PI_DISPATCH_PI_BIN", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_CODING_AGENT_SESSION_DIR"]);
export const PILOT_ENV_DENY_PREFIX = "PI_DISPATCH_DURABLE_";

export function pilotEnv(depth: number, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(source)
		.filter(([key]) => !PILOT_ENV_DENY.has(key) && !key.startsWith(PILOT_ENV_DENY_PREFIX)));
	return { ...env, PI_DISPATCH_DEPTH: String(depth) };
}

const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * The pilot child's stdout is this file, not a pipe: Pi exits on its next
 * stdout write once a pipe reader is gone, so a pipe would end the worker
 * with its owner. The file also survives as completion evidence.
 */
export const PILOT_EVENTS_FILE = "events.log";

function pilotPreflight(options: PilotProcOptions): string | undefined {
	if (!path.isAbsolute(options.piExecutable) || !fs.statSync(options.piExecutable, { throwIfNoEntry: false })?.isFile()) {
		return `Pilot requires an absolute Pi executable; got ${JSON.stringify(options.piExecutable)}`;
	}
	if (!SESSION_ID.test(options.sessionId)) return `Invalid pilot session ID ${JSON.stringify(options.sessionId)}`;
	if (!path.isAbsolute(options.sessionDir)) return "Pilot session directory must be absolute";
	if (!THINKING_LEVELS.has(options.thinking)) return `Invalid thinking level ${JSON.stringify(options.thinking)}`;
	const resolved = options.registry ? resolveChildModel(options.registry, options.model) : undefined;
	const exact = options.registry ? resolved && `${resolved.provider}/${resolved.id}` : options.model;
	if (exact !== options.model || !options.model.includes("/")) return `Pilot model ${JSON.stringify(options.model)} is not an exact provider/id`;
	return undefined;
}

/** Run exactly one pilot child: one spawn, no fallback, no quota routing. */
export async function runPilotProc(agent: AgentConfig, task: string, options: PilotProcOptions): Promise<PilotProcResult> {
	const refused = (error: string): PilotProcResult => ({
		agent: agent.name, task, status: "error", text: "", error, ms: 0, attempts: 0, spawned: null, launched: false, settled: false, spendKnown: false,
	});
	const invalid = pilotPreflight(options);
	if (invalid) return refused(invalid);
	if (options.signal?.aborted) return { ...refused("Aborted before start"), status: "aborted" };
	const seen: PilotSeen = { launched: false, settled: false, completions: 0, spendKnown: true };
	let spawned: PilotProcResult["spawned"] = null;
	fs.mkdirSync(options.sessionDir, { recursive: true });
	const result = await runOneProc(agent, task, {
		cwd: options.cwd, signal: options.signal, requireCleanWorktree: options.requireCleanWorktree,
		modelOverride: options.model, thinking: options.thinking, onStream: options.onStream, onWarning: options.onWarning,
	}, {
		command: options.piExecutable,
		prefixArgs: options.piPrefixArgs ?? [],
		sessionArgs: ["--session-id", options.sessionId, "--session-dir", options.sessionDir],
		eventsFile: path.join(options.sessionDir, PILOT_EVENTS_FILE),
		seen,
		onSpawn: async (pid) => {
			const { processStartIdentity } = await import("./durable/store.ts");
			const startIdentity = await processStartIdentity(pid);
			if (!startIdentity) return `Cannot establish start identity of worker process ${pid}`;
			spawned = { pid, startIdentity };
			try {
				await options.onSpawn(pid, startIdentity);
				return undefined;
			} catch (error) {
				return `Worker identity was not recorded: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	});
	const mismatch = result.status === "ok" && seen.sessionId !== options.sessionId;
	return {
		...result,
		status: mismatch ? "error" : result.status,
		error: mismatch ? `Child session ${JSON.stringify(seen.sessionId ?? null)} does not match ${options.sessionId}` : result.error,
		sessionId: seen.sessionId,
		spawned,
		launched: seen.launched,
		settled: seen.settled,
		spendKnown: seen.completions > 0 && seen.spendKnown,
	};
}

export function pricedUsage(usage: Usage | undefined): boolean {
	if (!usage) return false;
	if (!Number.isFinite(usage.totalTokens) || usage.totalTokens < 0) return false;
	const cost = usage.cost?.total;
	if (!Number.isFinite(cost) || cost < 0) return false;
	return usage.totalTokens === 0 || cost > 0;
}

interface PilotSeen { sessionId?: string; launched: boolean; settled: boolean; completions: number; spendKnown: boolean }
interface PilotSpawn {
	command: string;
	prefixArgs: readonly string[];
	sessionArgs: readonly string[];
	/** Created exclusively; the child's stdout. */
	eventsFile: string;
	seen: PilotSeen;
	/** Resolves to an error message when the child must be stopped. */
	onSpawn: (pid: number) => Promise<string | undefined>;
}

async function runOneProc(
	agent: AgentConfig,
	task: string,
	options: RunWorkerProcOptions,
	pilot?: PilotSpawn,
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
	// Let the child's actual selected model choose its adaptation, including CLI defaults.
	const promptExtension = createRequire(import.meta.url).resolve("@pf/pi-model-prompts/extension");
	const session = pilot?.sessionArgs ?? ["--no-session"];
	const args: string[] = ["-p", ...session, "--mode", "json", "--extension", promptExtension];
	for (const entry of web.extensionPaths) args.push("--extension", entry);
	if (web.tools.length > 0) {
		args.push("--tools", web.tools.join(","));
	} else {
		args.push("--no-tools");
	}
	// Recursion backstop: the child must never be able to dispatch.
	args.push("--exclude-tools", "dispatch,pr_review,feature_plan,council,durable_batch");
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
	if (model) {
		const slash = model.indexOf("/");
		args.push("--provider", model.slice(0, slash), "--model", model);
	}
	args.push("--thinking", thinking);
	options.onAttempt?.(model ?? "child default", thinking, 1);
	const systemPrompt = workerSystemPrompt(agent, web.warning);
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
			case "session":
				if (pilot && pilot.seen.sessionId === undefined && typeof event.id === "string") pilot.seen.sessionId = event.id;
				break;
			case "agent_settled":
				if (pilot) pilot.seen.settled = true;
				break;
			case "message_start":
			case "message_end": {
				const message = event.message as ChildMessage | undefined;
				if (message && event.type === "message_end") {
					endedMessages.push(message);
					if (message.role === "assistant") {
						if (pilot) {
							pilot.seen.completions++;
							if (!pricedUsage(message.usage)) pilot.seen.spendKnown = false;
						}
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
	const invocation = pilot
		? { command: pilot.command, args: [...pilot.prefixArgs, ...args] }
		: getPiInvocation(args);
	// Pilot children write events to a file and stderr nowhere, so they outlive their owner.
	const eventsFd = pilot ? fs.openSync(pilot.eventsFile, "wx", 0o600) : undefined;
	const proc = spawn(invocation.command, invocation.args, {
		cwd: options.cwd,
		shell: false,
		stdio: eventsFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", eventsFd, "ignore"],
		detached: process.platform !== "win32",
		env: pilot ? pilotEnv(childDepth) : { ...process.env, PI_DISPATCH_DEPTH: String(childDepth) },
	});
	if (eventsFd !== undefined) fs.closeSync(eventsFd);
	let termination: Promise<void> | undefined;
	let gateError: string | undefined;
	if (pilot && proc.pid) pilot.seen.launched = true;
	const gate = pilot && (proc.pid
		? pilot.onSpawn(proc.pid)
		: Promise.resolve("Pilot child did not start")).then((error) => {
		if (!error) return;
		gateError = error;
		termination ??= stopWorker(proc, options.onWarning);
	});
	const feed = (data: string) => {
		buffer += data;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
	};
	const tail = pilot ? tailFile(pilot.eventsFile, feed) : undefined;
	proc.stdout?.setEncoding("utf8");
	proc.stdout?.on("data", feed);
	// stderr is diagnostic only — it must never become model-visible text.
	proc.stderr?.resume();

	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;
	await new Promise<void>((resolve) => {
		proc.on("close", (code, signal) => {
			exitCode = code;
			exitSignal = signal;
			tail?.drain();
			if (buffer.trim()) processLine(buffer);
			resolve();
		});
		proc.on("error", () => {
			tail?.drain();
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

	await gate;
	await termination;

	if (gateError) return { ...fail("error", gateError), model, usage: sumUsage(endedMessages) };

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

/** Poll a growing file and pass new UTF-8 text on. `drain` reads the rest and stops; it is idempotent. */
function tailFile(file: string, onData: (text: string) => void): { drain: () => void } {
	const fd = fs.openSync(file, "r");
	const decoder = new StringDecoder("utf8");
	const chunk = Buffer.alloc(64 * 1024);
	const read = () => {
		for (let n = fs.readSync(fd, chunk); n > 0; n = fs.readSync(fd, chunk)) onData(decoder.write(chunk.subarray(0, n)));
	};
	const timer = setInterval(read, 100);
	let open = true;
	return {
		drain: () => {
			if (!open) return;
			open = false;
			clearInterval(timer);
			try { read(); onData(decoder.end()); } finally { fs.closeSync(fd); }
		},
	};
}
