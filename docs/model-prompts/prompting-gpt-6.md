# GPT-6 prompting choices

Sources: OpenAI's [Using GPT-6: prompting best practices](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices),
the [GPT-6.1 Sol announcement](https://openai.com/index/introducing-gpt-6-1-sol/),
and [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).
OpenAI presents the best practices as a starting point for the whole GPT-6
family, derived from behavior observed with Astra.

## Astra

`gpt-6-astra`:

- Carry authorized implementation through relevant verification, rather than stopping at a plan.
- Resolve routine choices; ask about material uncertainty in correctness, scope, or authorization.
- Cite the instruction behind a blocker and continue unaffected authorized work.
- Complete required checks; repeat or broaden testing only for a concrete reason.
- Delegate independent work only when role permissions, available tools, and user instructions allow it.
- Lead with the result in plain language and report validation and blockers.

## 6.1 Sol

`gpt-6.1-sol` (and dash-suffixed variants) uses the same family guidance on
follow-through, approval timing, verification, and writing. It differs from
Astra where the announcement points to Sol's changes:

- Explicit restrictions are hard limits. The announcement reports better
  respect for explicit restrictions and fewer unauthorized outcomes.
- Tool failures are reported, not papered over with a guess. OpenAI tests
  whether the model discloses a broken search tool.
- Current and file-specific facts are checked with tools. The announcement
  reports its largest factuality gain at low reasoning effort.
- No delegation line. OpenAI's delegation guidance addresses Astra delegating
  less than desired; dispatch decides delegation through roles.

## Retired

GPT-6 Sol and GPT-6 Luna are removed from the local model set and receive no
guidance; the generic `gpt-6` family is gone. The API still serves those models,
so an explicit selection runs with the base prompt only.

## Boundaries

Review-only tasks do not authorize edits, reversible actions are not
automatically authorized, and model guidance does not override applicable
project instructions. These are prompting choices, not measured performance
improvements. Reasoning effort (6.1 Sol supports `low` through `max`, not `none`
or `minimal`), caching, and reasoning-history handling are runtime concerns
outside this extension.
