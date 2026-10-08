# Claude Sonnet 5.5 prompting

Based on Anthropic's [Prompting Claude Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5).

## Applied guidance

- Finish all authorized work; stop for a blocking decision or required approval.
- Ideas, options, and planning requests stop at that deliverable.
- Stop once requested work and required checks are complete. Avoid unrelated additions or self-started review and hardening rounds. Launch reviewers only when review is requested or required by applicable instructions.
- Run a real relevant test, typecheck, build, or changed command before reporting completion. A superficial syntax check or failed-to-start check is not verification. Install declared dependencies only when authorized, with the project's package manager and lockfile; do not use elevated privileges as a workaround.
- Retrieve current evidence for changing facts, policies, requirements, and prices.
- Batch independent calls, use exact declared tool and parameter names, and correct tool errors using feedback. Provide progress notes when the role and output contract allow them.

Sonnet 5 is retired locally and receives no guidance. These instructions apply
only to Sonnet 5.5.

## Runtime concerns, not implemented here

Effort, adaptive versus between-tools thinking, structured outputs, JSON parsing,
progress-display betas, user-message placement, refusal handling, and image tools
are runtime responsibilities. This extension does not enable those features or
remap tool names; dispatch's existing fail-closed tool handling remains intact.

Required repository tests and review gates are preserved. The prompt does not
claim measured reductions in cost or premature stops.
