/**
 * Model-specific guidance, appended to the system prompt on every request.
 * Loaded by Pi as its own extension entry and passed to child workers with
 * `--extension`, so the child's actual model selects the guidance.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildAdaptedSystemPrompt } from "./adaptations.ts";
import { knownModelFamily } from "./families.ts";

export default function modelPrompts(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		if (!ctx.model) return;
		const systemPrompt = buildAdaptedSystemPrompt(event.systemPrompt, knownModelFamily(ctx.model));
		if (systemPrompt !== event.systemPrompt) return { systemPrompt };
	});
}
