# Claude Fable 5.1 prompting

Based on Anthropic's [Prompting Claude Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1).

The adaptation applies to `claude-fable-5-1`, `claude-fable-5.1`, and the
`neuralwatt/fable-5.1` route.

## Applied guidance

- Complete the authorized scope, execute actionable next steps, and finish unblocked work. Assessment and planning requests do not authorize implementation.
- Prefer targeted edits; report unrelated improvements rather than implementing them. Keep permanent tests proportionate and preserve required project checks.
- Batch independent calls while respecting dependencies and authorization for state-changing commands.
- Give progress updates only when the role and output contract allow them. Make the final response cover the whole task.
- Use direct language, paragraph breaks, and helpful formatting. Mark quotations and cite sources.
- Retrieve evidence for unfamiliar names and changing facts; include the user's original name in a search query.

We do not tell interactive agents that the user is absent, or grant permission
for all reversible actions. Dispatch's planner remains read-only and its existing
role and deliverable remain authoritative.

## Runtime concerns, not implemented here

The guide also covers effort sweeps, progress-display beta headers, turn-scoped
batching reminders, append-only thinking history, compaction summaries, output
budgets, asynchronous subagents, and image tools. Prompt text does not implement
these features. This extension does not rewrite conversation history, tune effort,
add reminders after tool results, change compaction, or alter tool behavior.

In particular, dispatch currently waits for worker results; this prompt does not
pretend it has asynchronous launch/wait tools. No performance gain is claimed
without workload evaluations.
