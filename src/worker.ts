/**
 * In-process worker runner (research tier).
 *
 * Each worker is a hermetic AgentSession:
 * - Own DefaultResourceLoader with noExtensions/noSkills/noContextFiles and
 *   the agent's system prompt (kills dispatch-in-dispatch recursion and cuts
 *   worker startup to ~10-40ms).
 * - Own SessionManager (in-memory, compaction disabled).
 * - Tool allowlist from the agent definition.
 *
 * Context firewall: the parent only ever receives the final (or partial, on
 * abort) assistant text — never intermediate tool calls or transcripts.
 */

import type { Usage } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { resolveWorkerModel, sharedModelRuntime } from "./model.ts";
import {
	loadRosterConfig,
	markCooldown,
	resolveCandidates,
	type RankedCandidate,
} from "./roster.ts";
import type { AgentConfig, WorkerResult } from "./types.ts";

export interface RunWorkerOptions {
	registry: ModelRegistry;
	/** Parent's active model; used when the agent spec says "inherit". */
	fallbackModel: Model | undefined;
	cwd?: string;
	signal?: AbortSignal;
	/** Called at message/tool boundaries so the TUI can update (never per-delta). */
	onBoundary?: () => void;
	/** Opt-in: persist the worker session for later resumption. */
	persist?: boolean;
	/** Resume a persisted worker session from its file (continues the convo). */
	resumeFile?: string;
}

/** Where persisted worker sessions live: <agentDir>/pi-dispatch/sessions. */
function workerSessionsDir(): string {
	return path.join(getAgentDir(), "pi-dispatch", "sessions");
}

export interface WorkerSessionRecord {
	file: string;
	agent: string;
	savedAt: number;
}

function workerIndex(): {
	path: string;
	read: () => Record<string, WorkerSessionRecord>;
} {
	const dir = path.join(getAgentDir(), "pi-dispatch");
	const indexPath = path.join(dir, "index.json");
	return {
		path: indexPath,
		read: () => {
			try {
				return JSON.parse(fs.readFileSync(indexPath, "utf-8"));
			} catch {
				return {};
			}
		},
	};
}

/** Best-effort sessionId → sessionFile index (details/resume bookkeeping). */
export function recordWorkerSession(
	sessionId: string,
	file: string,
	agent: string,
): void {
	if (!file) return;
	try {
		const index = workerIndex();
		fs.mkdirSync(workerSessionsDir(), { recursive: true });
		const map = index.read();
		map[sessionId] = { file, agent, savedAt: Date.now() };
		fs.writeFileSync(index.path, JSON.stringify(map, null, 2));
	} catch {
		// Persistence is best-effort; the dispatch itself must not fail.
	}
}

/** Look up a persisted worker session by id for resumption. */
export function findWorkerSession(
	sessionId: string,
): WorkerSessionRecord | undefined {
	try {
		return workerIndex().read()[sessionId];
	} catch {
		return undefined;
	}
}

/** Sum usage across assistant messages in the worker session. */
function sumUsage(messages: Array<{ role: string; usage?: Usage }>): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
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

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
	if (!a && !b) return undefined;
	const x = a ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const y = b ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		input: x.input + y.input,
		output: x.output + y.output,
		cacheRead: x.cacheRead + y.cacheRead,
		cacheWrite: x.cacheWrite + y.cacheWrite,
		totalTokens: x.totalTokens + y.totalTokens,
		cost: {
			input: x.cost.input + y.cost.input,
			output: x.cost.output + y.cost.output,
			cacheRead: x.cost.cacheRead + y.cost.cacheRead,
			cacheWrite: x.cost.cacheWrite + y.cost.cacheWrite,
			total: x.cost.total + y.cost.total,
		},
	};
}

export async function runWorker(
	agent: AgentConfig,
	task: string,
	options: RunWorkerOptions,
): Promise<WorkerResult> {
	const started = Date.now();
	const base = {
		agent: agent.name,
		task,
		attempts: 0,
		ms: 0,
	};

	const fail = (status: WorkerResult["status"], error: string): WorkerResult => ({
		...base,
		status,
		text: "",
		error,
		ms: Date.now() - started,
	});

	if (options.signal?.aborted) return fail("aborted", "Aborted before start");

	const rosterConfig = await loadRosterConfig();
	const candidates = resolveCandidates(agent, rosterConfig);

	if (candidates.length === 0) {
		// No roster/frontmatter override: try inherit fallback once as a single candidate.
		if (!options.fallbackModel) {
			return fail(
				"error",
				`No model available for agent "${agent.name}" (spec: ${agent.model ?? "inherit"})`,
			);
		}
		const result = await runOneCandidate(
			agent,
			task,
			options,
			{
				modelSpec: `${options.fallbackModel.provider}/${options.fallbackModel.id}`,
				thinking: "off",
				entry: {
					provider: options.fallbackModel.provider,
					model: options.fallbackModel.id,
					thinking: "off",
					weight: 1,
				},
			},
			options.fallbackModel,
		);
		return { ...result, attempts: 1, ms: Date.now() - started };
	}

	let aggregatedUsage: Usage | undefined;
	let lastError: string | undefined;

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		const model = resolveWorkerModel(
			options.registry,
			candidate.modelSpec,
			undefined,
		);
		if (!model) {
			// Config error (typo'd model id), not a model-health failure: fail the
			// candidate without poisoning cooldowns.
			lastError = `No model available for candidate "${candidate.modelSpec}"`;
			continue;
		}

		const attempt = await runOneCandidate(agent, task, options, candidate, model);
		aggregatedUsage = addUsage(aggregatedUsage, attempt.usage);
		lastError = attempt.error;
		if (attempt.status === "ok") {
			return { ...attempt, usage: aggregatedUsage, attempts: i + 1, ms: Date.now() - started };
		}
		// Abort is user-initiated, never a candidate failure: return immediately,
		// keep the partial text, and do NOT poison cooldowns for models that
		// never failed.
		if (attempt.status === "aborted" || options.signal?.aborted) {
			return {
				...attempt,
				status: "aborted",
				usage: aggregatedUsage,
				attempts: i + 1,
				ms: Date.now() - started,
			};
		}
		markCooldown(candidate.entry.provider, candidate.entry.model);
	}

	// All candidates exhausted (or all failed to resolve).
	return {
		...base,
		status: "error",
		text: "",
		error:
			lastError ??
			`All ${candidates.length} model candidate(s) failed for agent "${agent.name}"`,
		usage: aggregatedUsage,
		attempts: candidates.length,
		ms: Date.now() - started,
	};
}

async function runOneCandidate(
	agent: AgentConfig,
	task: string,
	options: RunWorkerOptions,
	candidate: RankedCandidate,
	model: Model,
): Promise<WorkerResult> {
	const started = Date.now();
	const base = {
		agent: agent.name,
		task,
		attempts: 0,
		ms: 0,
	};

	const fail = (status: WorkerResult["status"], error: string): WorkerResult => ({
		...base,
		status,
		text: "",
		error,
		model: candidate.modelSpec,
		thinking: candidate.thinking,
		ms: Date.now() - started,
	});

	if (options.signal?.aborted) return fail("aborted", "Aborted before start");

	const modelRuntime = await sharedModelRuntime(options.registry, model);
	const effectiveCwd = options.cwd ?? process.cwd();
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
	});

	const loader = new DefaultResourceLoader({
		cwd: effectiveCwd,
		// Required string in this pi version; resolvePath(undefined) throws.
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: agent.systemPrompt || `You are ${agent.name}. ${agent.description}`,
	});
	await loader.reload();

	const sessionManager = options.resumeFile
		? SessionManager.open(options.resumeFile)
		: options.persist
			? SessionManager.create(effectiveCwd, workerSessionsDir())
			: SessionManager.inMemory(effectiveCwd);

	const { session } = await createAgentSession({
		cwd: effectiveCwd,
		model,
		thinkingLevel: candidate.thinking,
		// Hermetic workers: only built-ins from the agent allowlist. Empty list
		// (frontmatter `tools: none`) means no tools at all.
		...(agent.tools && agent.tools.length > 0
			? { tools: agent.tools }
			: { noTools: "all" as const }),
		resourceLoader: loader,
		settingsManager,
		sessionManager,
		modelRuntime,
	});

	// Abort propagation: parent signal -> worker session.
	const onAbort = () => session.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const unsubscribe = session.subscribe((event) => {
		// Throttle UI updates to message/tool boundaries, never per-delta:
		// host + N workers share one event loop.
		if (
			event.type === "message_end" ||
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_end"
		) {
			options.onBoundary?.();
		}
	});

	try {
		await session.prompt(task);
	} catch (err) {
		// An abort mid-prompt throws: classify it as abort (with partial text and
		// usage), not as a candidate error — otherwise the failover loop would
		// retry a dead signal and stamp a bogus cooldown.
		const abortedMidPrompt = options.signal?.aborted === true;
		const partialUsage = sumUsage(session.agent.state.messages);
		const partialText = session.getLastAssistantText() ?? "";
		unsubscribe();
		options.signal?.removeEventListener("abort", onAbort);
		session.dispose();
		return {
			...fail(
				abortedMidPrompt ? "aborted" : "error",
				String(err instanceof Error ? err.message : err),
			),
			text: abortedMidPrompt ? partialText : "",
			usage: partialUsage,
		};
	}

	const aborted = options.signal?.aborted === true;
	const lastMessage = session.agent.state.messages.at(-1);
	const failed = lastMessage?.stopReason === "error";
	const finalText = session.getLastAssistantText() ?? "";
	// Blank-response detection (pi-harness pattern): a completed turn whose
	// assistant content carries no text at all — thinking-only or literally
	// empty — is a failed attempt, not a legitimate short answer. It fails
	// over to the next roster candidate; aborts keep their partial text.
	const blank =
		!failed && !aborted && finalText.trim().length === 0;

	const result: WorkerResult = {
		...base,
		status: failed ? "error" : aborted ? "aborted" : blank ? "error" : "ok",
		text: finalText,
		error: failed
			? lastMessage?.errorMessage
			: blank
				? "blank response (no text in final assistant message; thinking-only or empty)"
				: undefined,
		sessionId: session.sessionId,
		model: candidate.modelSpec,
		thinking: candidate.thinking,
		usage: sumUsage(session.agent.state.messages),
		ms: Date.now() - started,
	};
	if (options.persist) {
		recordWorkerSession(session.sessionId, session.sessionFile ?? "", agent.name);
	}
	unsubscribe();
	options.signal?.removeEventListener("abort", onAbort);
	session.dispose();
	return result;
}

/**
 * Cap a single worker's output so one chatty worker can't blow up the
 * master's context. Mirrors the official example's truncate semantics:
 * the cap counts UTF-8 bytes (12KB = 12*1024 bytes — `text.length` would
 * undercount for non-ASCII, letting CJK/emoji-heavy output through at up
 * to 4x the cap), and the cut lands on a code-point boundary so it never
 * splits a multi-byte sequence or surrogate pair.
 */
const MAX_OUTPUT_BYTES = 12 * 1024;

export function truncateText(text: string, maxBytes = MAX_OUTPUT_BYTES): {
	text: string;
	truncated: boolean;
} {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return { text, truncated: false };
	}
	const buf = Buffer.from(text, "utf8");
	// Back off continuation bytes (10xxxxxx) so bytes [0, end) are complete
	// UTF-8 sequences; buf[end] is then a leading byte, i.e. the partially
	// cut sequence itself is excluded.
	let end = Math.min(maxBytes, buf.length);
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return {
		text: `${buf.subarray(0, end).toString("utf8")}\n\n[output truncated: ${buf.length - end} bytes dropped]`,
		truncated: true,
	};
}
