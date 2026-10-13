import { getSupportedThinkingLevels, Type, type Api, type Model } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, type ThinkingLevel } from "./types.ts";

export const THINKING_REFUSAL = "[dispatch:thinking-refused]";

const ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const rank = (level: string) => ORDER.indexOf(level as ThinkingLevel);
const atLeast = (level: string, floor: ThinkingLevel) => rank(level) >= rank(floor);

/**
 * Minimum effort per role. Review, planning, judgment and writing stay at
 * `high`. Discovery (scout) and merging or pattern checks (aggregator,
 * slop-reviewer) spend most of their time in short tool rounds, where
 * reasoning multiplies the cost of every round.
 */
export const ROLE_FLOORS: Readonly<Record<string, ThinkingLevel>> = {
	scout: "low",
	aggregator: "medium",
	"slop-reviewer": "medium",
};
export const DEFAULT_FLOOR: ThinkingLevel = "high";
export const roleFloor = (role: string | undefined): ThinkingLevel => (role && ROLE_FLOORS[role]) || DEFAULT_FLOOR;

/** Workflow and child-worker efforts: the high floor, exactly. */
export type TaskThinking = "high" | "xhigh" | "max";
export const TASK_THINKING: ReadonlySet<string> = new Set(["high", "xhigh", "max"]);
export const DEFAULT_TASK_THINKING: TaskThinking = "high";
export const TaskThinkingSchema = Type.Union([Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
export const isTaskThinking = (value: unknown): value is TaskThinking => typeof value === "string" && TASK_THINKING.has(value);
/** Dispatch task items: any level; the role floor is checked at run time. */
export const ThinkingLevelSchema = Type.Union(ORDER.map((level) => Type.Literal(level)));

export function requireTaskThinking(value: unknown): TaskThinking {
	if (!isTaskThinking(value)) throw new Error(`${THINKING_REFUSAL} Unsupported thinking ${JSON.stringify(value)}; choose high, xhigh, max.`);
	return value;
}

/** A resolved effort. Explicit requests run exactly; defaults may rise to the nearest supported level. */
export interface ThinkingRequest {
	level: ThinkingLevel;
	explicit: boolean;
}

function requireLevel(value: unknown, floor: ThinkingLevel, role: string | undefined): ThinkingLevel {
	if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
		throw new Error(`${THINKING_REFUSAL} Unsupported thinking ${JSON.stringify(value)}; choose one of ${ORDER.join(", ")}.`);
	}
	if (!atLeast(value, floor)) {
		throw new Error(`${THINKING_REFUSAL} Thinking ${value} is below the ${role ?? "worker"} floor ${floor}.`);
	}
	return value as ThinkingLevel;
}

/**
 * Precedence: task choice → saved resume → agent/roster configuration → role floor.
 * Task and resume choices are explicit and must meet the role floor.
 * Configuration below the floor is raised to it with a warning.
 */
export function resolveRequest(
	choices: { task?: string; savedResume?: string; resumeSource?: string; agentConfig?: string },
	role?: string,
	configSource = "agent configuration",
	warn?: (message: string) => void,
): ThinkingRequest {
	const floor = roleFloor(role);
	if (choices.task !== undefined) return { level: requireLevel(choices.task, floor, role), explicit: true };
	const resumed = choices.savedResume !== undefined;
	const configured = resumed ? choices.savedResume : choices.agentConfig;
	if (configured === undefined) return { level: floor, explicit: false };
	if (!THINKING_LEVELS.has(configured)) requireLevel(configured, floor, role);
	if (atLeast(configured, floor)) return { level: configured as ThinkingLevel, explicit: resumed };
	const source = resumed ? `Resumed session ${choices.resumeSource ?? "(saved)"}` : configSource;
	warn?.(`${source}: thinking ${configured} raised to ${floor}.`);
	return { level: floor, explicit: false };
}

/** Workflow invocations set the effort of high-floor roles only; other roles keep their role default. */
export function workflowThinking(role: string, invocation: TaskThinking): TaskThinking | undefined {
	return roleFloor(role) === DEFAULT_FLOOR ? invocation : undefined;
}

/**
 * Effort for one model. Explicit requests need exact support. Defaults run at
 * the lowest supported level at or above the request, so a role default can
 * cross a model that lacks that exact level (GLM has no `medium`).
 */
export function resolveEffective(request: ThinkingRequest | TaskThinking, model?: Model<Api>): { effective: ThinkingLevel; verified: boolean } {
	const { level, explicit } = typeof request === "string" ? { level: requireTaskThinking(request), explicit: true } : request;
	if (!model) return { effective: level, verified: false };
	// SDK virtual-models.ts uses api === "pi-virtual"; selection metadata cannot verify its physical route.
	if (model.api === "pi-virtual") throw new Error(`${THINKING_REFUSAL} Virtual model ${model.provider}/${model.id} cannot guarantee exact thinking; choose a physical model.`);
	const supported = getSupportedThinkingLevels(model);
	const effective = explicit
		? supported.find((candidate) => candidate === level)
		: ORDER.find((candidate) => atLeast(candidate, level) && supported.includes(candidate));
	if (!effective) {
		throw new Error(`${THINKING_REFUSAL} Unsupported thinking ${level} for ${model.provider}/${model.id}; supported choices: ${supported.join(", ") || "none"}.`);
	}
	return { effective, verified: true };
}

export function effortLabel(result: { requestedThinking?: string; thinking?: string }): string {
	const effective = result.thinking ?? "unknown";
	return result.requestedThinking && result.requestedThinking !== effective
		? `${result.requestedThinking}→${effective}` : effective;
}
