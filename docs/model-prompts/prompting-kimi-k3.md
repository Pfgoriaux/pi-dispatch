# Kimi K3 prompting choices

State the deliverable, stopping condition, and permission boundaries. For
analysis-only work, evidence is the deliverable and edits are prohibited.
For authorized implementation, report checks and unresolved blockers.

Moonshot notes that K3 may answer from memory instead of calling a tool, so the
adaptation asks it to check current and file-specific facts with tools first.
K3 always thinks; request conclusions and evidence, not visible step-by-step
reasoning. When a prompt asks for JSON, only the final `content` counts, never
`reasoning_content`.

These are local prompt choices. This extension does not preserve or transform
reasoning history, configure thinking effort, or implement dynamic tool loading;
those are runtime responsibilities. It never grants edit permission merely
because Kimi is selected.

Provider references: [Kimi K3 quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart),
[K3 tool-calling best practices](https://platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice),
[Moonshot prompting guidance](https://platform.kimi.ai/docs/guide/prompt-best-practice).
Verify provider-specific settings independently of these prompts.
