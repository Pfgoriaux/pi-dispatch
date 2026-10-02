/** Task prompts for feature_plan's architect → pre-mortem → challenger → final plan flow. */

export interface PlanContext {
	cwd: string;
	idea: string;
	focus: string;
}

function header(c: PlanContext, goal: string): string[] {
	const lines = [
		goal,
		"Read applicable AGENTS.md instructions first; do not modify the repository.",
		`Repository: ${c.cwd}`,
		"",
		"FEATURE IDEA:",
		c.idea,
	];
	if (c.focus) lines.push("", `FOCUS / scope hint from the user: "${c.focus}". Explore there first.`);
	return lines;
}

/** Architect draft: discover the code, then design the feature. */
export function architectDraftTask(c: PlanContext): string {
	return [
		...header(c, "You are the architect for this feature. Discover the relevant code, then design the implementation."),
		"",
		"Read the relevant instructions, data model, flows, and tests before designing.",
		"",
		"Return a draft design (Markdown, under ~150 lines and 10 KB):",
		"## Goal",
		"## Scope (in, out, and what stays unchanged)",
		"## Current state (relevant files and flows, with paths)",
		"## Architecture (boundaries, interfaces, data changes, invariants)",
		"## Draft tasks (owned files, behavior, dependencies)",
		"## Risks and unknowns",
		"## Product decisions needed (only choices the code cannot answer)",
	].join("\n");
}

/** Cheap pre-mortem: the single most likely failure cause three months out. */
export function preMortemTask(c: PlanContext, draft: string): string {
	return [
		...header(c, "Run a pre-mortem on this feature design."),
		"",
		"DRAFT DESIGN:",
		draft,
		"",
		"Question: this feature shipped as designed. Three months later it broke. What is the most likely reason?",
		"Check the draft against the actual code. Consider data growth, concurrency, upstream changes, migrations, config drift, and operational load.",
		"",
		"Return (under ~60 lines):",
		"## Most likely failure (one paragraph, with the code evidence behind it)",
		"## Runners-up (max 3, one line each)",
		"## What would prevent it (concrete design change or check)",
	].join("\n");
}

/** Design challenger: independent review of the draft, informed by the pre-mortem. */
export function challengerTask(c: PlanContext, draft: string, preMortem: string): string {
	return [
		...header(c, "Challenge this feature design. You are an independent reviewer, not its author."),
		"",
		"DRAFT DESIGN:",
		draft,
		"",
		"PRE-MORTEM (cheap model; verify before relying on it):",
		preMortem,
		"",
		"Check the design against the actual code. Look for wrong assumptions, missing failure paths, migration and compatibility risks,",
		"interface contracts that workers could misread, and a simpler approach that meets the same goal.",
		"Report only issues that would cause incorrect behavior, rework, or a failed check. Omit style preferences.",
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
	"- Executor reason: <one line, required for `precise`>",
	"- Read first: <AGENTS.md files and source paths the worker must read>",
	"- Depends on: <task numbers or none>",
	"- Owns: <exact file paths>",
	"- Behavior: <observable behavior to implement>",
	"- Contracts: <interfaces, data shapes, and invariants to keep>",
	"- Verify: <tests and checks that prove it works>",
	"- Escalate when: <findings that require the architect, not a worker redesign>",
];

/** Architect finalize: resolve the challenge and produce worker-ready task contracts. */
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
		"Each task goes to a cheaper implementation model that has not seen this design. It must be executable from its contract alone.",
		"Keep independent tasks separate so they can run in parallel; order dependent tasks.",
		"Answer technical questions yourself. Ask the human only about product decisions the code cannot answer.",
		"",
		"Return the plan with this structure (Markdown, under 10 KB; output past 12 KB is cut):",
		"",
		"# Feature plan: <short title>",
		"## Goal",
		"## Decisions for you (product decisions only; write \"None\" if there are none)",
		"## Scope (in, out, unchanged)",
		"## Architecture (boundaries, interfaces, data changes, invariants)",
		"## Challenge resolution (each issue: accepted or rejected, one line why)",
		"## Final verification (checks and observable behavior after all tasks)",
		"## Execution tasks",
		...TASK_CONTRACT,
	].join("\n");
}
