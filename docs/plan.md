# Feature plan: pi-dispatch — hybrid multi-agent dispatch extension

> Historical design record, begun 2026-09-03 and partially annotated during
> implementation. Not a current specification or work queue. The README and
> source describe shipped behavior. In particular, the closure depth counter,
> 50 KB cap, module layout, model-selection semantics, and cleanup policy below
> were superseded. Preserve the record rather than implementing it verbatim.
> See [README](../README.md) and [the first review](review-1.md).

## Goal & why

A pi extension (`dispatch` tool) that lets the master agent fan out to N parallel sub-agents
with **two context firewalls** (worker → master sees only final text; N workers → master sees
only the aggregator's distilled text), tiered execution (in-process read-only research workers,
git-worktree-isolated write workers), weighted model rosters with failover, progressive TUI
status, and abort-with-partial-results. The master context stays small no matter how large the
fan-out. Must work as a plain local pi extension; Herdr observability is an optional no-op-by-default add-on.

Context: the repo is greenfield (README only; 1 commit). Everything imports from the installed
pi 0.84.4 package (`@earendil-works/pi-coding-agent`) — no vendoring of pi itself. The official
subagent example (`examples/extensions/subagent/`) and the sibling pr-swarm/feature-swarm
extensions are the verified prior art. `aliou/pi-harness`
agent-kit is **not on disk** — its patterns (roster, blank-response detection, firewall,
collapsed-line render) are reimplemented, not vendored.

## Recommended scope (MVP first, then phases)

- **Phase 0 — Spikes (decision gates).** Small runnable scratch scripts, deleted after.
- **Phase 1 — MVP: parallel research tier.** `dispatch` tool with `single | parallel | chain`
  modes, in-process read-only workers via `createAgentSession()`, agents/*.md discovery,
  context firewall (content vs details), abort + partial results, progressive TUI rendering.
- **Phase 2 — Double firewall + rosters ✅** Separate read-only aggregator worker that distills
  the N worker outputs; weighted model rosters (`subagent-models.json`) with failover/cooldowns;
  blank-response detection.
- **Phase 3 — Write tier.** Child-`pi`-process workers in isolated git worktrees; merge agent
  that reconciles the branches back to the master branch.
- **Phase 4 — DONE (0.2.0).** Env-gated (`HERDR_ENV=1`) Herdr notification on dispatch
  completion, opt-in persist/resume worker sessions (dedicated session dir + index),
  packaging polish, merge-flow .gitignore bookkeeping committed.

## Where the code goes (modules/files, paths)

```
pi-dispatch/
├── package.json            # real runtime deps only (typebox); pi installs with --omit=dev
├── src/
│   ├── index.ts            # extension factory: pi.registerTool("dispatch"), command, config
│   ├── agents.ts           # agents/*.md frontmatter discovery (port of PI_EX/agents.ts)
│   ├── worker-sdk.ts       # in-process runner: createAgentSession() hermetic workers
│   ├── worker-proc.ts      # child pi process tier (port of PI_EX runSingleAgent)
│   ├── roster.ts           # subagent-models.json: [{provider, model, thinking, weight}],
│   │                       #   weighted pick, failover, cooldowns, blank-response detection
│   ├── worktree.ts         # git worktree add/remove/list, branches, merge orchestration, GC
│   ├── aggregate.ts        # fan-in: aggregator worker prompt over N outputs + firewall
│   ├── render.ts           # renderCall/renderResult, throttled onUpdate details (port PI_EX)
│   └── herdr.ts            # optional observability, gated on HERDR_ENV=1 + HERDR_SOCKET_PATH
├── agents/*.md             # frontmatter agent defs (name/description/tools/model/thinking)
├── prompts/*.md            # aggregator + merge-agent prompt templates
└── subagent-models.json    # roster config
```

Install: symlink into `~/.pi/agent/extensions/pi-dispatch/` or ship as a pi package
(`pi install git:...`; docs/packages.md). Frontmatter format stays byte-compatible with the
official example's `agents/*.md` so users can share agent files.

## Architecture & integration decisions

1. **Tiered execution.** Research tier (read-only `createReadOnlyTools`-style allowlists,
   `tools`/`excludeTools` per agent role) runs **in-process** — cheap, instant spawn, own
   `SessionManager.inMemory()` (compaction disabled via `SettingsManager.inMemory({compaction:
   {enabled:false}})`). Write tier runs **child `pi` processes** inside per-task git worktrees —
   strongest isolation, proven `runSingleAgent` pattern from the official example (env marker +
   depth guard for the child; `PI_PID`-style env propagation). A successful cwd-binding spike
   (Phase 0 #4) may later unlock in-process worktree workers as an opt-in mode; child-proc
   remains the default for writes.
2. **Recursion guard (the described `PI_SUBAGENT_DEPTH` env var does NOT work in-process).**
   Workers share `process.env` with the host, so env-based depth is a global race under
   concurrent dispatches. Resolution: (a) **structural** — hermetic `DefaultResourceLoader` per
   worker with `noExtensions: true`, plus `skillsOverride`/`systemPromptOverride`/`agentsFilesOverride`
   for slim, hermetic workers (kills dispatch-in-dispatch for the SDK tier and cuts startup
   weight); (b) **backstop** — closure/session-scoped depth counter in the extension factory
   (max depth 2, configurable), not env; (c) **child tier** passes a depth env var + the
   pr-swarm `SELF_EXCLUSIONS` pattern (`--exclude-tools dispatch`) as a second backstop.
3. **Double context firewall.** Tool-result `content` (model-visible) contains ONLY the
   aggregator/worker final assistant text + `sessionId` footer; `details` (UI-only) carries
   live per-worker status, and full transcripts live in worker session files (standard pi
   jsonl, resumable later via `SessionManager.open`). Never intermediate tool calls or partial
   transcripts in `content`. 50KB/task output cap, `truncateParallelOutput` semantics, ported.
4. **Aggregation cannot stream to the master model — by API design.** A tool's `content` is
   delivered to the LLM exactly once when `execute` resolves; `onUpdate` affects TUI rendering
   only. So fan-in/aggregation progress streams to the **UI** via `details`, and the master
   receives one final distilled blob. This resolves the open question: UI-only, deliberately.
5. **Aggregation format.** `content` = final text only (aggregator's final assistant text +
   sessionId footer). Structured per-worker results (status, exitCode, model used, tokens/cost,
   sessionId) go into `details` for the TUI. Optional per-task `format: "json"` param may ask
   the *aggregator prompt* to emit JSON, but the tool contract stays a text blob.
6. **Modes.** `single | parallel | chain`, `tasks[]` fan-out ported from the official example
   (MAX_PARALLEL_TASKS = 8, MAX_CONCURRENCY = 4, `mapWithConcurrencyLimit`). Tasks get the
   existing optional `cwd` field, which is how worktree workers are pointed at their tree.
7. **Rosters/failover.** `subagent-models.json` weighted pick; failover on
   blank-response/error via `stopReason` + `errorMessage` + exit code signals (SDK tier reads
   `session.messages` for final text; proc tier parses stderr/JSON events). Cooldowns are
   **in-memory per dispatch session** (simplest; no cross-session learning — see open
   questions). One shared `ModelRuntime` per dispatch, resolved via host `ctx.modelRegistry`.
   Rate limits multiply in-process — failover is load-bearing, not optional.
8. **Abort/cancel.** The `execute` `signal` is the abort key. Per-worker `session.abort()`
   (SDK tier) and SIGTERM→SIGKILL-after-5s (proc tier). Unlike the official example (which
   throws), we collect partial results: snapshot per-worker `session.messages` / final-so-far
   text before dispose/kill and emit partials marked `aborted`.
9. **Worktree lifecycle.** Extension-owned: `git worktree add <repo>/.dispatch/worktrees/<taskId>
   -b dispatch/<runId>/<taskId>`; worker runs with `cwd` = worktree. Success → merge agent
   runs (conflict parsing reuses `git-merge-and-resolve.ts`'s `<<<<<<<` diff-filter parsing),
   then `git worktree remove` + branch delete (branch optionally kept for audit). Abort/failure
   → keep worktree + branch, record branch names in `details` so nothing is lost. Startup GC
   removes stale worktrees (age/lockfile marker). Merge order: merge agent BEFORE
   `worktree remove`.
10. **agent-kit: reimplement, don't vendor.** The load-bearing pieces (roster, blank detection,
    firewall, collapsed-line/activity render) are ~300–500 LOC against pi's own verified API;
    agent-kit is neither on disk nor license-checked. Reimplement from architecture.
11. **TUI rendering.** Port the example's `renderCall`/`renderResult` streaming UI
    (Container/Markdown/Text/Spacer, thunk rendering, throttled `onUpdate` only at
    `message_end`/`tool_result_end`) — per-delta updates would dominate the event loop since
    host + N workers share it. Progressive status: one collapsed line per worker with activity
    spinner → expandable details.
12. **Tool naming.** Tool is named `dispatch` (distinct from the example's `subagent`) so both
    can coexist if the user has the example installed.

## Work breakdown (phased tasks, S/M/L)

**Phase 0 — Spikes (S each, throwaway scripts in /tmp)**
- S: N (≥2) concurrent `createAgentSession()` workers in one process: memory, extension
  re-load, shared ModelRuntime/auth under parallel load. Decision gate for in-process tiers.
- S: Slim worker construction: hermetic resource loader (noExtensions + overrides) — does it
  cut worker startup to <1s?
- S: Abort → partial-results: verify `session.abort()` leaves usable `session.messages` and a
  valid `sessionId`; `dispose()` clean while in-flight.
- S: Worktree write-isolation E2E: in-process worker with `cwd=worktree`; confirm bash/edit/git
  commit stay inside the worktree; session-file naming per cwd; no filename collisions for
  parallel `SessionManager` in the same agentDir.
- S: agent-kit reality check (optional): fetch `aliou/pi-harness` to sanity-check
  roster/render semantics before reimplementing.

**Phase 1 — MVP: research tier in-process (L)**
- M: `package.json`, `src/index.ts` — extension factory, `dispatch` tool registration
  (single/parallel/chain, tasks[], validation, MAX caps).
- M: `src/agents.ts` — agent discovery port; project-local `.pi/agents` requires
  `agentScope: project` opt-in + `ctx.isProjectTrusted()` confirm flow.
- L: `src/worker-sdk.ts` — hermetic in-process worker runner: createAgentSession with
  tools/excludeTools per role, inMemory session, closure depth guard, firewalled result
  (final text + sessionId footer only).
- M: `src/render.ts` — port of the collapsed parallel renderCall/renderResult with throttled
  streaming details.
- S: `prompts/*.md` initial set (researcher roles).
- M: Tests for all of the above.

**Phase 2 — Double firewall + roster (M)**
- M: `src/aggregate.ts` — read-only aggregator worker; prompt = N raw worker outputs (+
  task metadata); output = one distilled text into `content`; per-worker structured data in
  `details`; UI progress via onUpdate.
- M: `src/roster.ts` — subagent-models.json loading, weighted pick, failover chain,
  cooldown window, blank-response detection (both tiers), usage/token aggregation per worker.
- S: `SettingsManager` compaction-disabled worker settings shared config.
- M: Abort/partial bookkeeping hardened (mark partials, still firewall them through the
  aggregator when ≥1 worker succeeded).

**Phase 3 — Write tier (L)** — **implemented** (`src/worker-proc.ts`, `src/worktree.ts`, `src/merge.ts`, `agents/writer.md`; wired in `src/index.ts`)
- M: `src/worker-proc.ts` — child pi process runner (port of `runSingleAgent`: JSON-stream parse,
  SIGTERM → SIGKILL after 5s, partial text from `text_delta` events on abort) + `PI_DISPATCH_DEPTH`
  env marker + `--exclude-tools dispatch` + `--system-prompt` / `--tools` / `--no-tools` flags.
- L: `src/worktree.ts` — create/list/remove, branch naming `dispatch/<runId>/<taskId>`, dirty-repo
  precheck (tolerating only our own `.gitignore` append of `.dispatch/`), sequential-merge helpers,
  stale GC (>24h mtime or missing branch; branches kept for audit).
- L: Merge agent — merge loop over branches, `diff-filter=U` conflict detection and resolution
  prompt (tools bash/read/edit, run as a child pi process from the parent repo root),
  `git merge --abort` + keep branch on failure; outcome into `details.merges` only.
- Parallel mode: worktrees created up front (sequentially — `git worktree add` races on repo
  refs), branches merged back after ALL workers finish, then worktrees removed (merged branches
  deleted, failed/aborted kept). Chain mode: per-step worktree merges before the next step runs.
  Aggregation runs after merging.
- M: End-to-end: N write workers in parallel worktrees → merges → master context receives one
  aggregated summary. ✅ verified (two writer tasks → merged branches, worktrees cleaned up).

**Phase 4 — Polish + optional Herdr (M)**
- S: `src/herdr.ts` — `HERDR_ENV=1` + `HERDR_SOCKET_PATH` fire-and-forget status push, no-op
  elsewhere (pattern: herdr-agent-state.ts).
- M: Resumable sessions opt-in (`SessionManager.open(path)` footers become resumable task
  param).
- S: README/docs with minimum pi version, capability matrix, firewall explanation.
- S: Packaging as pi package (`pi install`).

## Test strategy

- **Unit** (vitest): agents.ts frontmatter parsing/normalization/edge files; roster weighting,
  cooldown, failover order; truncate/cap logic; worktree path/branch naming; firewall builder
  (content never contains tool calls/intermediate transcripts — property test).
- **Integration** (real model calls, small/cheap model, env-gated): 2-worker parallel research
  dispatch E2E (`pi -p` headless, assert tool `content` shape); abort mid-run returns partials
  marked aborted; chain mode; concurrency cap enforcement (MAX_CONCURRENCY=4 with 8 tasks).
- **E2E write tier**: temp git repo fixture — 2 parallel worktree workers editing distinct
  files → merge agent → assert merged tree + worktrees removed; conflicting edit fixture →
  conflict path keeps branches and reports.
- **Regression guards**: killed/crashed dispatch leaves no `.dispatch/worktrees` leak after
  GC; concurrent `dispatch` tool calls don't corrupt each other's depth/env state.

## Risks & mitigations

1. **Concurrent in-process sessions are undocumented territory** (sdk.md shows single-session
   usage). Mitigation: Phase 0 spike gates; child-proc tier as the escape hatch for both tiers.
2. **pi API churn** (0.84.4-pinned; jiti-loaded, fast-moving). Mitigation: README declares
   minimum pi version; CI smoke test re-verifies exports (`createAgentSession`,
   `SessionManager`, `parseFrontmatter`, `withFileMutationQueue`) on upgrade.
3. **Rate limits multiply from one process** (all parallel workers share auth credentials).
   Mitigation: roster failover/cooldowns are Phase 2-core, not optional.
4. **Blank-response detection false positives** (legit empty finals vs API failures).
   Mitigation: distinguish via `stopReason`/`errorMessage`/exit codes, not empty text alone.
5. **Worktree hazards**: fresh worktrees missing `node_modules`/venv; crash cleanup without
   `session_shutdown`; dirty main tree; stale worktree accumulation. Mitigation: prechecks,
   lockfile/age GC at startup, keep-on-abort policy, README warning about ignored build deps.
6. **Rendering churn** with host + N workers sharing one event loop. Mitigation: throttle
   `onUpdate` to message/tool-result boundaries (example's pattern).
7. **Tool-name collision** if the user also installs the `subagent` example. Mitigation:
   distinct name `dispatch`; README documents.
8. **Session file collisions** for parallel workers in one agentDir. Mitigation: spike;
   per-worker agentDir suffix if needed.

## Scout disagreements (and how resolved)

1. **Write tier: in-process SDK workers vs child pi processes.** Scout A leaned in-process +
   worktree for both tiers (isolation via worktree, not process), pending spike; Scout B
   recommended porting the example's child-proc `runSingleAgent` for write workers. 
   **Resolution:** MVP = in-process research tier + child-proc write tier in worktrees
   (strongest isolation, proven pattern); a passing cwd-binding spike may later allow
   in-process worktree workers as opt-in.
2. **Env-var depth guard.** Both scouts independently found `PI_SUBAGENT_DEPTH` does not exist
   in the shipped example (the brief overstates it — net-new) and cannot work in-process.
   **Resolution:** hermetic loader (structural) + closure-depth counter (SDK tier) + env marker
   & `--exclude-tools dispatch` (proc tier).
3. **Aggregation streaming.** Both scouts: model-visible streaming is impossible (`content`
   delivered once) and undesirable anyway. **Resolution:** UI-only.
4. **Session persistence.** Scout A raised the question; Scout B proposed inMemory default.
   **Resolution:** `SessionManager.inMemory()` for research workers (compaction off);
   disk-persisted sessions for worktree workers and the aggregator; explicit resumability
   opt-in in Phase 4.
5. **Naming trivia:** `roster.ts` vs `roaster.ts` — resolved to `roster.ts`.

## Open questions for the human

1. Should worktree merges be applied automatically by the merge agent, or require human
   confirmation in the TUI before `execute` returns?
2. Shared agents directory (`~/.pi/agent/agents/*.md`, compatible with the official example)
   vs an extension-owned agents directory (cleaner versioning)?
3. Headless/non-interactive mode (`pi -p`, `ctx.hasUI === false`): should project-local agent
   scopes and confirm dialogs default-deny?
4. Should roster weights/cooldowns persist across sessions (disk state) or stay in-memory
   per dispatch session (current plan)?
5. Vendor-and-adapt agent-kit if it turns out to be permissively licensed, or keep the
   ~300–500 LOC reimplementation (current plan)?

## Out of scope

- Dispatching to remote/cloud agent runtimes.
- Streaming partial worker transcripts into the master model context (violates the firewall).
- Re-implementing pi's session format (worker sessions stay standard pi jsonl).
- Cross-extension orchestration protocol (Herdr panes are observability only, not a
  dependency or transport).
- GUI/desktop rendering beyond the pi TUI.
