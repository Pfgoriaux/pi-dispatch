/** Bound failed tool loops without exposing arguments or guessing malformed names. */
export interface ToolBoundary {
	type: "tool_execution_start" | "tool_execution_end";
	toolName: string;
	isError?: boolean;
}

export class ToolHealth {
	private invalidStreak = 0;
	private failureStreak = 0;
	private readonly allowed: Set<string>;
	failure?: string;

	constructor(tools: readonly string[]) {
		this.allowed = new Set(tools);
	}

	/** Unknown names can contain model-generated arguments, paths, or control codes. */
	format(event: ToolBoundary): string {
		const name = this.allowed.has(event.toolName) && /^[\w.-]{1,100}$/.test(event.toolName)
			? event.toolName : "[unregistered tool]";
		const status = event.type === "tool_execution_end"
			? event.isError ? " [error]" : " [ok]" : "";
		return `${event.type}: ${name}${status}`;
	}

	observe(event: ToolBoundary): string | undefined {
		if (this.failure || event.type !== "tool_execution_end") return this.failure;
		this.invalidStreak = this.allowed.has(event.toolName) ? 0 : this.invalidStreak + 1;
		this.failureStreak = event.isError ? this.failureStreak + 1 : 0;
		if (this.invalidStreak >= 3) {
			this.failure = "Worker stopped after 3 consecutive calls to unavailable tools (possible malformed tool-call loop).";
		} else if (this.failureStreak >= 5) {
			this.failure = "Worker stopped after 5 consecutive tool errors without a successful tool result.";
		}
		return this.failure;
	}
}
