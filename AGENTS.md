# pi-dispatch

Delegates bounded tasks to Pi sessions and returns final reports, not transcripts.
In-process workers investigate and review; child processes write in isolated
worktrees. Usage, model routing, installation and Herdr: [README.md](README.md).

## Boundaries

- Model-visible `content` holds reports and recovery references (sessions,
  saved plans, retained branches). `details` is UI-only; never put the only
  copy of a recovery reference there.
- Use `truncateText` for reports and errors: 12 KB of UTF-8 per text, preserving
  code points. Combined reports and metadata can exceed that per-text cap.
- In-process workers disable context-file, skill and general extension discovery.
  Their tasks must carry applicable constraints or point to instruction files.
  Only configured Linkup entrypoints load. Child writers load project context
  and global extensions normally; do not describe both tiers as hermetic.
- Roles, cwd confinement and worktrees are not shell/filesystem sandboxes.
  Model choice does not grant tools or authorization.
- Writers require authorization to edit and commit. They return retained branches;
  the coordinator reviews and integrates only with authorization. PR merges need
  user review and authorization. Never force-delete dirty/locked worktrees or
  delete by age. Successful handoffs require clean edits and the assigned branch/base.
- Review fixes must start from the reviewed head. Keep head pinning.
- Internal failed-tool cutoffs and startup timeouts are attempt failures, not user
  aborts. Preserve parent-cancellation precedence, no writer replay after tool use,
  usage accounting and fallback behavior.
- Do not log raw child stderr or malformed tool names: either may contain secrets.
  Never repair malformed tool names into executable calls.
- Expand chain `{previous}` placeholders with a replacer function so dollar
  sequences in reports remain literal.
- Discover the advertised roster through the same trust/override path as execution.
  Keep model-specific guidance subordinate to role, task and project constraints.
- Herdr viewers and metadata belong to the caller's workspace. Visibility failures
  remain non-fatal and reported; release owned resources in `finally`. Metadata
  `--source` sequences updates but does not own keys; see README for workspace rules.

## Checks

Pi loads `src/index.ts` directly. Run `npm ci --ignore-scripts`, then
`npm run check` (TypeScript and deterministic tests, also run in Linux/macOS CI).
Tests use mocked models/commands and disposable Git fixtures, not live providers
or Herdr. The SDK import requires the `pi-server` development dependency but
does not start a server. Live writer checks require authorized disposable repos;
they create commits and retained worktrees.
