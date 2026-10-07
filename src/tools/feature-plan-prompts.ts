export interface PlanContext {
	cwd: string;
	idea: string;
	focus: string;
}

function header(c: PlanContext, goal: string): string[] {
	const lines = [
		goal,
		"Read applicable AGENTS.md instructions first; do not modify the repository.",
		"If an input report is truncated, read its saved file completely with offset/limit before using it.",
		`Repository: ${c.cwd}`,
		"",
		"FEATURE IDEA:",
		c.idea,
	];
	if (c.focus) lines.push("", `FOCUS / scope hint from the user: "${c.focus}". Explore there first.`);
	return lines;
}

export function architectDraftTask(c: PlanContext): string {
	return [
		...header(c, "You are the architect for this feature. Discover the relevant code, then design the implementation."),
		"",
		"Scale detail to the feature. A small feature usually needs one or two implementation tasks; larger features may need more.",
		"Reference repository instructions and source paths instead of repeating their contents. Include only decisions and context workers cannot rediscover safely.",
		"Return a concise draft design (Markdown; omit empty sections):",
		"## Goal",
		"## Scope (in, out, and what stays unchanged)",
		"## Current state (relevant files and flows, with paths)",
		"## Architecture (boundaries, interfaces, data changes, invariants)",
		"## Draft tasks (owned files, behavior, dependencies)",
		"## Risks and unknowns",
		"## Product decisions needed (only choices the code cannot answer)",
	].join("\n");
}

export function preMortemTask(c: PlanContext, draft: string): string {
	return [
		...header(c, "Run a pre-mortem on this feature design."),
		"",
		"DRAFT DESIGN:",
		draft,
		"",
		"Question: this feature shipped as designed. Three months later it broke. What is the most likely reason?",
		"Start with the draft design. Inspect files it proposes to change, their direct callers and dependencies, and relevant tests.",
		"Do not audit the whole repository. Expand beyond that scope only to investigate a concrete risk identified in the draft or those files.",
		"",
		"Return at most 3 likely failures, ranked by likelihood, under 30 lines total.",
		"For each: state the failure, cite the draft section and supporting code paths/lines where available, and suggest a concrete preventive design change or check.",
		"If no risk is supported by the draft or code, return \"None\". Do not fill the quota with speculative risks.",
	].join("\n");
}

export function challengerTask(c: PlanContext, draft: string, preMortem: string): string {
	return [
		...header(c, "Challenge this feature design. You are an independent reviewer, not its author."),
		"",
		"DRAFT DESIGN:",
		draft,
		"",
		"PRE-MORTEM (verify its claims against the code):",
		preMortem,
		"",
		"Check the design against the actual code. Look for wrong assumptions, missing failure paths, migration and compatibility risks,",
		"interface contracts that workers could misread, and a simpler approach that meets the same goal.",
		"Report only issues that would cause incorrect behavior, rework, or a failed check.",
		"",
		"Return (under ~120 lines):",
		"## Verdict (sound / sound with changes / rethink)",
		"## Issues (each: problem, evidence path, required change)",
		"## Pre-mortem assessment (confirmed, rejected, or adjusted, with evidence)",
		"## Simpler alternative (only if it meets the same goal)",
	].join("\n");
}

const TASK_CONTRACT = [
	"### Task N: <title>",
	"- Executor: exactly one of `long` (default), `aperture/neuralwatt/glm-5.3` (small, well-bounded), or `precise` (auth, migrations, concurrency, shared interfaces)",
	"- Executor reason: <only required for `precise`>",
	"- Repository: <repo root the task runs in>",
	"- Source pointers: <only essential paths the worker would otherwise miss; omit if none>",
	"- Depends on: <task numbers or none>",
	"- Owns: <exact file paths>",
	"- Behavior: <observable behavior to implement>",
	"- Contracts: <interfaces, data shapes, and invariants to keep>",
	"- Verify: <tests and checks that prove it works>",
	"- Escalate when: <only non-obvious boundaries requiring a decision; omit if none>",
];

export function architectFinalTask(c: PlanContext, draft: string, preMortem: string, challenge: string): string {
	return [
		...header(c, "You are the architect. Finalize your design into an execution plan."),
		"",
		"YOUR DRAFT DESIGN:",
		draft,
		"",
		"PRE-MORTEM:",
		preMortem,
		"",
		"DESIGN CHALLENGE:",
		challenge,
		"",
		"Resolve every challenge issue: accept it and change the design, or reject it with evidence. Verify disputed claims in the code.",
		"Workers have repository access but not this conversation. Each contract must carry the outcome, ownership, dependencies, non-obvious decisions, shared interfaces, and acceptance checks needed to execute it.",
		"Implementation workers run child pi sessions that load project context normally. Do not repeat AGENTS.md instructions or reminders in task contracts; name nested instruction files only when workers would otherwise miss them. Omit copied files, routine steps, and discovery transcripts.",
		"Scale plan length to scope, not a fixed word limit. Small features usually need one or two short implementation contracts; large features may need more coordination detail.",
		"Split tasks only for meaningful ownership or dependencies. Keep routine checkout preparation, documentation, and final checks with the coordinator or an implementation task, not separate workers.",
		"Tasks in one dispatch call share one repository and feature checkout; different repositories need separate calls.",
		"Keep independent tasks separate so they can run in parallel; order dependent tasks. Put exact shared interfaces in the contracts that need them without repeating a separate architecture section.",
		"Answer technical questions yourself. Ask the human only about product decisions the code cannot answer.",
		"",
		"Return the following Markdown, omitting empty or redundant sections.",
		"",
		"# Feature plan: <short title>",
		"## Goal",
		"## Decisions for you (\"None\" if empty)",
		"## Scope (in, out, unchanged)",
		"## Execution tasks",
		...TASK_CONTRACT,
		"## Final verification (checks and observable behavior after all tasks)",
		"## Challenge resolution (only rejected or unresolved findings needing explanation; accepted fixes belong in contracts)",
	].join("\n");
}
