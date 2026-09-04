/**
 * Shared types for pi-dispatch.
 */

import type { Usage } from "@earendil-works/pi-ai";

/** Valid pi thinking levels. */
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export const THINKING_LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/** Parsed agents/*.md definition. Byte-compatible with the official example's format. */
export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

export type WorkerStatus = "ok" | "error" | "aborted";

export interface WorkerResult {
	agent: string;
	task: string;
	status: WorkerStatus;
	/** Final (or partial, on abort) assistant text. Empty on hard error. */
	text: string;
	error?: string;
	sessionId?: string;
	model?: string;
	thinking?: string;
	usage?: Usage;
	/** Number of model candidates tried (details-only). */
	attempts: number;
	ms: number;
}

/** UI-only details carried on the tool result. Never sent to the model. */
export interface DispatchDetails {
	mode: "single" | "parallel" | "chain" | "resume";
	items: WorkerResult[];
	aggregated: boolean;
	truncated: boolean;
	/** Planned worker count (tasks, excluding aggregator). Denominator for progress. */
	total?: number;
	/** True on progress updates only — final results never set it. */
	running?: boolean;
	/** Write-tier (worktree) merge summary — UI-only, never model-visible. */
	merges?: { merged: string[]; failed: { branch: string; error: string }[] };
}
