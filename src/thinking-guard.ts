/** Loaded explicitly only by child workers. Hook exceptions are swallowed by Pi,
 * so an unsupported request must end the child before the provider call. */
import { writeSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requireThinkingLevel, resolveEffective } from "./thinking.ts";

export default function thinkingGuard(pi: ExtensionAPI): void {
	pi.registerFlag("dispatch-thinking", { description: "Exact worker thinking requirement", type: "string" });
	let providerRequestAllowed = false;
	const guard = (_event: unknown, ctx: ExtensionContext) => {
		try {
			// The parent checked the role floor; the child verifies the exact level on its actual model.
			const request = requireThinkingLevel(pi.getFlag("dispatch-thinking"));
			if (!ctx.model) throw new Error("Cannot verify worker thinking without the selected model.");
			resolveEffective({ level: request, explicit: true }, ctx.model);
			if (ctx.thinkingLevel !== request) throw new Error(`Worker thinking changed: requested ${request}, actual ${ctx.thinkingLevel ?? "unknown"}.`);
		} catch (error) {
			try {
				writeSync(1, JSON.stringify({ type: "dispatch_thinking_error", preInference: !providerRequestAllowed, error: (error as Error).message }) + "\n");
			} finally {
				process.exit(1);
			}
		}
	};
	pi.on("before_agent_start", guard);
	pi.on("before_provider_request", (event, ctx) => {
		guard(event, ctx);
		providerRequestAllowed = true;
	});
}
