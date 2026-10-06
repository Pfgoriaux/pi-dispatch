# pi-dispatch

Delegation tools for Pi. Workers return reports; writers also return retained
branches. Dispatch never integrates code or merges PRs.

```text
coordinator
├─ research/review workers → findings
└─ writers → isolated worktrees → tests + commits → branch handoffs
coordinator → review → authorized integration → combined checks → PR
user → review and authorize PR merge
```

## Tools

All four tools are `model-only`: call them directly, not through codemode.

| Tool | Use |
|---|---|
| `dispatch` | One helper, parallel tasks, or sequential research |
| `feature_plan` | Read-only design and implementation contracts |
| `pr_review` | Read-only review; optional fixes on a retained branch |
| `council` | Three independent opinions on a consequential decision |

Do routine work directly. Use one advisor for focused judgment; multiple workers
for independent or context-heavy tasks. Each task needs its goal, paths, constraints
and deliverable because workers do not see the coordinator's conversation.

### Dispatch modes

- `{ agent, task }`: one in-process worker.
- `{ tasks: [{ agent, task, cwd?, model?, worktree? }] }`: up to 8 tasks,
  concurrency 4. An aggregator normally combines reports; `aggregate:false`
  returns them separately.
- `{ chain: [{ agent, task, cwd?, model? }] }`: up to 8 sequential steps;
  `{previous}` inserts the preceding report. Chain worktrees are rejected.
- `persist:true` retains in-process sessions under
  `<agentDir>/pi-dispatch/sessions`, with lookup records in `pi-dispatch/index.json`.
  Continue with `{ resume: "<sessionId>", task: "..." }`.
  Write children do not use this persistence path.
- `herdr:false` disables viewers/metadata; a task-level value overrides it.

Per-task `cwd` must resolve inside the session directory. A `writer` requires
`tasks` with `worktree:true`; single/resume and non-worktree writer calls fail.
Other roles' shell permissions remain instructions, not a filesystem sandbox.

### Writer handoffs

```js
dispatch({
  target: "/path/inside/session/feature-checkout",
  tasks: [{ agent: "writer", task: "...", worktree: true }]
})
```

- `target` defaults to the session cwd. It must be a clean repo root on a named
  feature branch; `main`, `master`, `production` and detached HEAD are rejected.
  A call has one target. Worktree tasks cannot set per-task `cwd`.
- Worktrees branch from one pinned commit. Writers need authorization to edit
  and commit, stage only task files, and do not push or merge.
- A successful writer must leave clean edits, the assigned branch and a HEAD
  descending from its base. Changed/detached branches return an error with the
  actual HEAD for recovery. No-op tasks do not create empty commits.
- Every started worktree stays, including failed/aborted tasks. One worker's
  exception becomes its error result while siblings finish.
- The handoff includes path, branch, base/head commits, count and readiness.
  It appears outside aggregator text and in `details.worktrees`.
- The coordinator reviews selected branches and integrates only with user
  authorization. Test the combined code before dispatching dependent work.
  PR merges remain a separate, user-reviewed action.
- Keep not-ready worktrees for recovery. After verified integration and a clean
  tree, use `git worktree remove <path>`, then `git branch -d <branch>`.
  Stop if Git refuses; there is no forced or age-based deletion.

Repos inside the workspace (parent of `PI_WORKTREE_ROOT`, default
`~/eden/.worktrees`) mirror their main checkout path under that directory.
Other repos use `<repo>/.dispatch/worktrees`, excluded through Git's local
`info/exclude`, not tracked `.gitignore`. New worktrees lack ignored dependencies
such as `node_modules`; install them only when authorized.

### Feature planning

```text
feature_plan({ idea, focus? })
└─ Architect (Astra): discover and draft
   └─ Pre-mortem (DeepSeek): inspect likely failure
      └─ Challenger (Opus): independently check the design
         └─ Architect: resolve issues and return task contracts
```

The draft and final architect use the same model; the challenger cannot use it.
Prompts scale detail to scope and put unresolved product decisions before tasks.
The tool does not implement its plan. After approval, execute contracts verbatim
with the named Executor, one repository per dispatch call.

Full successful reports are saved privately under `<agentDir>/pi-dispatch/plans`.
Previews are capped at 12 KB and include paths; later steps read full reports
when previews are truncated. If a truncated report cannot be saved, planning
stops and returns its preview plus a session recovery path when available.
Recover existing reports rather than replanning because a preview was cut.
Reports remain until manually removed.

A failed draft stops the run. Missing pre-mortem/challenge results remain visible;
a failed final step returns earlier reports. Configure defaults with
`DISPATCH_ARCHITECT_MODEL`, `DISPATCH_PREMORTEM_MODEL` and
`DISPATCH_CHALLENGER_MODEL`.

### PR review

`pr_review({ pr?, intent, fix?, herdr? })` accepts a GitHub PR number (via `gh`),
revision range, branch compared with HEAD, or the default origin-base comparison.
Invalid diffs fail before models start; empty diffs skip model calls.

```text
parallel
├─ Opus reviewer: correctness/security
├─ Astra reviewer: correctness
├─ DeepSeek scout (medium thinking): pre-mortem
└─ slop-reviewer: unnecessary code/docs
reviewer → verify findings against diff and code → report
```

The two code reviewers cannot share a model after fallback. If both fail, review
stops; failed verification returns unverified reports. Configure the first three
steps with `DISPATCH_REVIEW_OPUS_MODEL`, `DISPATCH_REVIEW_ASTRA_MODEL` and
`DISPATCH_REVIEW_PREMORTEM_MODEL`.

`fix` defaults to false. Authorized fixes require a trusted, clean feature repo
root matching the reviewed head. After successful, untruncated verification, a
writer starts from that pinned head and returns a retained branch, never a merge.
It uses the default writer tier. For auth, migrations, concurrency or shared
interfaces, review only, then dispatch an authorized `precise` writer.

### Council

`council({ question, context?, third?, herdr? })` runs Opus, Astra and GLM 5.3
by default; `third:"kimi-k3"` replaces GLM. All use high thinking and the advisor
role, restricted to local read/search tools even when custom roles grant more.
Configured Linkup tools remain available.

Seats stay on their assigned model. GLM/Kimi can retry an equivalent provider
route; unavailable seats are reported, not replaced by another model. No aggregator
runs. The coordinator summarizes agreement, dissent, its recommendation and the
smallest next check. Fewer than three successful opinions is not a full council.

## Agents and models

Discovery order: bundled `agents/`, user `<agentDir>/agents/`, then trusted
project `.pi/agents/`; later definitions override earlier ones. The coordinator
receives current role names and tools before each turn, not all role prompts.

| Role | Local tools | Default tier |
|---|---|---|
| scout | read/search | cheap |
| investigator | read/search, bash (read-only diagnostics) | precise |
| advisor | read/search | precise |
| planner | read/search | precise |
| reviewer | read/search, bash (read-only inspection) | balanced |
| security-reviewer | read/search, bash (read-only inspection) | precise |
| slop-reviewer | read/search, bash (read-only inspection) | balanced |
| aggregator | none | balanced |
| writer | read, edit, write, bash | long |

| Tier | Default model | Thinking |
|---|---|---|
| cheap | Aperture Neuralwatt DeepSeek V4.1 Flash | off |
| balanced | Anthropic Sonnet 5.5 | high |
| precise | Anthropic Opus 5.5 | high |
| long | Aperture Neuralwatt Kimi K3 | high |

Use Kimi for default coding, explicit `aperture/neuralwatt/glm-5.3` for small,
well-bounded tasks, and `precise` for high-risk coding. Override a tier with
`DISPATCH_PROFILE_<TIER>_MODEL` or a task's `model` with a tier or `provider/id`.
Model choice never grants additional tools or authorization.

In-process selection uses a task override, otherwise an agent roster, then
frontmatter, then the parent model. Rosters live in
`<agentDir>/settings/subagent-models.json`:

```json
{
  "planner": [
    { "provider": "anthropic", "model": "claude-opus-5-5", "thinking": "high", "weight": 2 },
    { "provider": "openai-codex", "model": "gpt-6-astra", "thinking": "high", "weight": 1 }
  ]
}
```

Weights are positive and ordered descending, not sampled. A task model override
bypasses the roster. Worktree/review-fix children do not read in-process rosters
or cooldowns: they use the task override or frontmatter, then parent for `inherit`.
Child IDs resolve through the parent registry; ambiguous or unpinnable IDs fail
before spawn.

### Routing and failure

- Kimi and DeepSeek retry their Neuralwatt/Synthetic counterparts (direct and
  Aperture routes supported). Kimi and GLM 5.3 retain a terminal Codex Sol 6.1
  fallback; DeepSeek falls back through Sonnet then Sol.
- Opus and Astra retry each other and end with Sol; Sonnet also falls back to Sol.
  Ordinary GLM routing stays on Neuralwatt before Sol; workflow last resorts
  additionally include GLM on Neuralwatt and direct Synthetic.
- `feature_plan` and `pr_review` exclude Sol and end their chains with GLM 5.3
  on Neuralwatt, then direct Synthetic. Model-identity guards prevent duplicates.
  Council instead restricts each seat to its assigned model.
- Quota steering ranks existing peer candidates without inserting a top model.
  Tiers/rosters opt in; concrete pins and `inherit` keep provider order.
  Every attempt still skips fresh, known exhausted providers.
- Snapshots come from `<agentDir>/cache/usage-bar/<provider>-v3.json` written by
  pi-usage-bar. Use the lowest remaining percentage across reported windows.
  Missing, invalid, older-than-three-minute or expired-reset readings do not
  predict capacity. Dispatch neither polls providers nor reserves quota.
- In-process failures, blank final responses and internal cutoffs can try the
  next candidate. Usage includes all attempts. Cooldowns last 60 seconds per
  provider/model. Cutoffs occur after 3 unavailable-tool calls or 5 consecutive
  tool errors; success resets them.
- A write child is never replayed after a tool starts. Parent cancellation wins
  over failures and never triggers retry.
- `PI_DISPATCH_STARTUP_TIMEOUT_MS` defaults to 120000. Child startup waits for
  an agent/message/tool-start event; silent startup is stopped without retry.
  In-process prompts wait for model output after session setup; timeout follows
  normal fallback. Healthy workers have no total-runtime deadline.
- Child startup failures expose OS/module diagnostic codes, never raw stderr.
  Malformed tool names are redacted, not repaired. POSIX cancellation signals
  owned processes and known descendants, escalating after a grace period;
  already daemonized processes may escape.

## Context and tools

Only the selected role prompt loads into a worker, plus shared worker rules and
model-family guidance from the packaged `@pf/pi-model-prompts` dependency.
Keep its vendor archive, dependency and lockfile together when updating it.

In-process workers disable general extension, skill and context-file discovery.
Their tasks must provide constraints or name applicable instruction files.
Write children use normal project/global loading, exclude the four orchestration
tools, and omit the Dispatch roster when `PI_DISPATCH_DEPTH > 0`. Depth above 2
is refused. Roles, worktrees and cwd checks are not sandboxes; shell access reaches
outside the assigned directory. Workers are instructed not to launch agent CLIs
to bypass tool or delegation restrictions.

Configured Linkup search/answer/fetch tools are added to all workers, even roles
without local tools. In-process workers load only those entrypoints. Install
`npm:@aliou/pi-linkup` and supply `LINKUP_API_KEY` through approved secret storage.
For a trusted local/Git package, set `DISPATCH_LINKUP_PACKAGE_DIR` to its absolute
path. Missing setup warns and leaves local tools usable; broken registration
fails explicitly. Never send secrets/private code in queries.

Final reports and recovery references enter model-visible `content`.
Status, usage and previews are in UI-only `details`. Worker/error texts have
a 12 KB UTF-8 cap per text plus a truncation marker, not per combined result. Raw transcripts stay inside
workers; saved reports/session references allow recovery without repeating work.

## Herdr

Herdr is optional. Inside Herdr, viewers and Spaces metadata show role, model,
attempt and state; `herdr:false` opts out. Neither surface executes extra agents.
Notifications and visibility failures are non-fatal. Owned tabs/rows are cleaned
up at the end; failed cleanup reports a warning and retains affected logs.

Use one coordinator per Herdr workspace. Calls in the same Pi process share rows,
but independent processes can overwrite workspace-wide keys. The extension reserves
`dispatch_1`–`dispatch_12`; overflow is counted in the final row. Heartbeats renew
60-second metadata expiry every 20 seconds.

Spaces configuration (Herdr 0.8.2+), merged into `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"], ["branch", "git_status"],
  ["$dispatch_1"], ["$dispatch_2"], ["$dispatch_3"], ["$dispatch_4"],
  ["$dispatch_5"], ["$dispatch_6"], ["$dispatch_7"], ["$dispatch_8"],
  ["$dispatch_9"], ["$dispatch_10"], ["$dispatch_11"], ["$dispatch_12"],
]
```

Check with `herdr config check`, then `herdr server reload-config`.
Metadata rows are labels, not clickable agents; viewer tabs show activity.
The extension does not edit Herdr configuration.

### Standalone workers

For workers prompted through Herdr directly, call
`herdr_watch({ action:"watch", targets:["worker-name-or-pane-id"] })` afterwards.
The watcher polls every three seconds, following pane/session identity.
A settled or blocked worker sends a coordinator follow-up; idle/done is not proof
of task success. Read the response, resolve authorized blockers, and re-register
after each continuation. `list` shows watches; `clear` stops watches, not workers.

Watches require TUI/RPC, not print mode. Notices remain pending until delivered,
survive reload in the same workspace/session, and do not follow forks or tree
navigation. Missing workers alert after three checks; replaced sessions alert
rather than being followed. No monitoring runs while Pi is closed, and delivery
is not exactly-once across crashes. The watcher never prompts workers or grants
permission.

## Install and checks

Requires Pi 1.0.4+. Pin a reviewed, pushed commit:

```bash
pi install git:github.com/Pfgoriaux/pi-dispatch@<commit>
```

Pi installs Git packages under its agent directory, separately from development
checkouts. Remove this extension's local-path settings entry before enabling the
Git entry; those sources have different package identities. Replace pins
intentionally between tasks. Stop workers before updating the Pi binary, then
restart sessions.

Development:

```bash
npm ci --ignore-scripts
npm run check
```

Checks cover TypeScript and deterministic tests on Linux/macOS, using disposable
Git repos and mocked models/commands. They do not verify live providers or Herdr.
The repository does not auto-load its extension into development sessions;
use `pi -ne -e ./src/index.ts` for an explicit isolated load.
