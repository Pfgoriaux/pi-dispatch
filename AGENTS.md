# pi-dispatch

Read and follow [shared working rules](RULES.MD).

Delegates scoped work to isolated pi sessions and returns final reports instead of
raw worker transcripts. Research runs in-process; write-tier tasks run child pi
processes in Git worktrees. Usage and current behavior: [README.md](README.md).

## Design constraints

- Keep intermediate transcripts out of model-visible results. Structured status
  and usage belong in `details`; current `persist`/`resume` modes also append
  session identifiers to `content`. This is an intentional API exception to the
  final-report-only policy and needs coverage when changing result construction.
- Apply `truncateText` to model-visible report and error text. The per-text cap
  is 12 KB of UTF-8, not code units; preserve code-point boundaries. Multiple
  reports and metadata can make the total result larger than one per-text cap.
- Chain interpolation uses a replacer function so dollar sequences in worker
  output remain literal. Task cwd validation resolves real paths and confines
  the starting directory to the session subtree; it is not a filesystem sandbox.
- In-process workers disable extension discovery, skills, and context-file loading.
  All roles get Linkup web tools when configured, in addition to their local tool
  allowlist. Only Linkup entrypoints load, never unrelated extensions or spawning
  tools. Missing setup warns without blocking local work. Their tasks must carry
  applicable constraints or explicit instructions to read the relevant files.
  Do not assume they inherit the parent's AGENTS.md.
- Child-process write workers have a separate loader and depth/exclusion guard;
  do not claim all tiers are hermetic. Worktrees separate changes but do not
  prevent shell access to other paths.
- Worktree dispatch commits worker changes and merges branches automatically.
  Use it only when the user has authorized those effects. Agent selection alone
  does not imply worktree execution: single mode is always in-process.
  Never force-delete dirty or locked worktrees; retained directories are recovery
  data. Age alone is not permission to remove a worktree. Write workers must pass
  the clean-worktree check before merge-back; merge agents intentionally do not.
- PR fixes must match the reviewed head. Never auto-select repository-local
  scanner scripts during read-only review; only resolved external executables qualify.
- In-process failed-tool cutoffs are model-attempt failures, not user aborts;
  keep failover, usage accounting, and parent-cancellation precedence intact.
  Viewer logs must not echo unregistered tool names: malformed names may contain
  arguments or private paths. Never repair a tool name into an executable call.
- Preserve the safety-sensitive fixes recorded in [review-1.md](docs/review-1.md),
  especially literal chain interpolation and cwd validation. That review and
  [plan.md](docs/plan.md) are historical records, not current implementation specs.

## Implementation and checks

`src/index.ts` registers the tool and advertises the live roster before each
main-agent turn. Keep advertised roles on the same discovery/trust path as
execution; do not hardcode a separate list. `src/linkup.ts` adds shared Linkup tools
from a trusted installation to both worker tiers; setup and usage are in README.md. Worker, worktree/merge, roster, and rendering
modules own their respective behavior; the workflow tools `pr_review` and
`feature_plan` (consolidated from the retired pi-pr-swarm / pi-feature-swarm)
live in `src/tools/` and reuse the same workers; agent prompts live in `agents/`.
Agent frontmatter `model:` names an effort tier (`cheap`/`balanced`/`precise`/`long`)
expanded by `src/profiles.ts` (env-overridable) — see the Effort tiers section
in [README.md](README.md).
Read [spikes-phase0.md](docs/spikes-phase0.md) only when investigating the pi SDK
version-specific behavior measured there.

Pi loads `src/index.ts` directly. Run `npm ci --ignore-scripts`, then
`npm run check` for TypeScript and deterministic regression tests. These use
mocked commands/models and disposable Git fixtures; they do not call providers or
operate live Herdr. CI runs the same check on Linux and macOS. The pinned SDK's native import
requires `pi-server` as a development dependency; dispatch does not start it.
Live E2E spawns models and write-tier E2E commits/merges, so use authorized
disposable fixtures.

Worker visibility is shared through `src/progress.ts`. Planned/running metadata
belongs in `details.activity`, separate from terminal `WorkerResult`s. Herdr
viewers and Spaces metadata rows default on inside Herdr, opt out with
`herdr:false`. Both belong to the caller's workspace, never Git worktrees or
additional execution agents. Sidebar setup and the one-master-per-workspace
boundary are in README.md. Herdr metadata `--source` sequences updates; it does
not provide ownership of token keys. Keep visibility failures non-fatal and
visible; clean up owned tabs and rows in `finally`.
