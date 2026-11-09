# Kimi K3 and K3.1 Pro prompting choices

Kimi K3.1 Pro is a post-trained Kimi K3 with the same API behavior described
here, so both families use the same adaptation.

State the deliverable, stopping condition, and permission boundaries. For
analysis-only work, evidence is the deliverable and edits are prohibited.
For authorized implementation, report checks and unresolved blockers.

Moonshot notes that K3 may answer from memory instead of calling a tool, so the
adaptation asks it to check current and file-specific facts with tools first.
K3 and K3.1 Pro always think; request conclusions and evidence, not visible step-by-step
reasoning. When a prompt asks for JSON, only the final `content` counts, never
`reasoning_content`.

These are local prompt choices. This extension does not preserve or transform
reasoning history, configure thinking effort, or implement dynamic tool loading;
those are runtime responsibilities. It never grants edit permission merely
because Kimi is selected.

Provider references: [Kimi K3 quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart),
[Kimi K3.1 Pro quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart),
[K3 tool-calling best practices](https://platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice),
[Moonshot prompting guidance](https://platform.kimi.ai/docs/guide/prompt-best-practice).
Verify provider-specific settings independently of these prompts.
