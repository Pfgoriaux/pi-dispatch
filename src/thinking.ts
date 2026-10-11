import { getSupportedThinkingLevels, Type, type Api, type Model } from "@earendil-works/pi-ai";
import { THINKING_LEVELS } from "./types.ts";

export type TaskThinking = "high" | "xhigh" | "max";
export const TASK_THINKING: ReadonlySet<string> = new Set(["high", "xhigh", "max"]);
export const DEFAULT_TASK_THINKING: TaskThinking = "high";
export const TaskThinkingSchema = Type.Union([Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
export const isTaskThinking = (value: unknown): value is TaskThinking => typeof value === "string" && TASK_THINKING.has(value);

export function requireTaskThinking(value: unknown): TaskThinking {
	if (!isTaskThinking(value)) throw new Error(`Unsupported thinking ${JSON.stringify(value)}; choose high, xhigh, max.`);
	return value;
}

/** Legacy configuration alone may be raised. Explicit task choices never change. */
export function resolveRequest(choices: {
	task?: string; invocationDefault?: string; savedResume?: string; agentConfig?: string;
}, configSource = "agent configuration", warn?: (message: string) => void): TaskThinking {
	const explicit = choices.task ?? choices.invocationDefault;
	if (explicit !== undefined) return requireTaskThinking(explicit);
	const legacy = choices.savedResume ?? choices.agentConfig ?? DEFAULT_TASK_THINKING;
	if (isTaskThinking(legacy)) return legacy;
	if (!THINKING_LEVELS.has(legacy)) return requireTaskThinking(legacy);
	warn?.(`${configSource}: thinking ${legacy} raised to high.`);
	return DEFAULT_TASK_THINKING;
}

/** Exact capability check; never use the SDK's upward/downward clamp. */
export function resolveEffective(request: TaskThinking, model?: Model<Api>): { effective: TaskThinking; verified: boolean } {
	requireTaskThinking(request);
	if (!model) return { effective: request, verified: false };
	const supported = getSupportedThinkingLevels(model);
	if (!supported.includes(request)) {
		throw new Error(`Unsupported thinking ${request} for ${model.provider}/${model.id}; supported choices: ${supported.join(", ") || "none"}. Dispatch requires high, xhigh, or max.`);
	}
	return { effective: request, verified: true };
}

export function effortLabel(result: { requestedThinking?: string; thinking?: string }): string {
	const effective = result.thinking ?? "unknown";
	return result.requestedThinking && result.requestedThinking !== effective
		? `${result.requestedThinking}→${effective}` : effective;
}
