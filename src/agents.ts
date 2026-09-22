/**
 * Agent discovery: frontmatter-markdown agent definitions.
 *
 * Format is byte-compatible with the official pi example
 * (examples/extensions/subagent/agents/*.md) so agent files can be shared.
 *
 * Priority (highest wins): project `.pi/agents/` (trusted projects only)
 * > user `~/.pi/agent/agents/` > agents bundled with this extension.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type AgentConfig } from "./types.ts";
import { expandModelSpec, tierThinking } from "./profiles.ts";

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
};

/** "read, bash" and [read, bash] are both valid YAML spellings for tools. */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	if (tools.length === 1 && tools[0].toLowerCase() === "none") return [];
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(
	dir: string,
	source: AgentConfig["source"],
): AgentConfig[] {
	const agents: AgentConfig[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		if (
			typeof frontmatter.name !== "string" ||
			typeof frontmatter.description !== "string"
		) {
			continue;
		}

		// Frontmatter `model` may name an effort tier (cheap/balanced/precise/
		// long; see src/profiles.ts) — expand it to a concrete spec so every
		// downstream consumer (candidates, write-tier child CLI) sees a real
		// model id. Anything else ("inherit", provider/id) passes through and
		// unknown ids fail clearly at candidate resolution, not silently.
		const rawModel =
			typeof frontmatter.model === "string" ? frontmatter.model : undefined;
		const tierDefault = tierThinking(rawModel);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: expandModelSpec(rawModel),
			// Frontmatter thinking overrides the tier default; frontmatter
			// thinking is optional and invalid values fall back to "off"
			// (or the tier default) rather than dropping the whole agent file.
			thinking:
				typeof frontmatter.thinking === "string" &&
				THINKING_LEVELS.has(frontmatter.thinking)
				? (frontmatter.thinking as AgentConfig["thinking"])
				: tierDefault && THINKING_LEVELS.has(tierDefault)
					? (tierDefault as AgentConfig["thinking"])
					: undefined,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}
	return agents;
}

/** Agents shipped with this extension (src/../agents). */
export function bundledAgentsDir(): string {
	return path.resolve(
		path.dirname(new URL(import.meta.url).pathname),
		"..",
		"agents",
	);
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	byName: Map<string, AgentConfig>;
}

export function discoverAgents(ctx: ExtensionContext): AgentDiscoveryResult {
	const merged = new Map<string, AgentConfig>();

	// Lowest priority first: bundled, then user, then project.
	for (const agent of loadAgentsFromDir(bundledAgentsDir(), "bundled")) {
		merged.set(agent.name, agent);
	}
	for (const agent of loadAgentsFromDir(
		path.join(getAgentDir(), "agents"),
		"user",
	)) {
		merged.set(agent.name, agent);
	}

	const projectDir = path.join(ctx.cwd, CONFIG_DIR_NAME, "agents");
	if (ctx.isProjectTrusted?.()) {
		for (const agent of loadAgentsFromDir(projectDir, "project")) {
			merged.set(agent.name, agent);
		}
	}

	return { agents: [...merged.values()], byName: merged };
}

export function agentRosterHelp(agents: AgentConfig[]): string {
	return agents
		.map((a) => `- ${a.name}: ${a.description} (${a.source})`)
		.join("\n");
}
