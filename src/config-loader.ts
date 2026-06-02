import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import z from "zod";
import { parse as yamlParse } from 'yaml';
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { builtInGeneralAgent } from "./default-agent.ts";
import type { AgentDefinition, Diagnostic, LoadedAgent, LoadedConfig } from "./types.ts";
import { AgentSchema } from "./types.ts";
import { canonicalizeAgentName, formatError } from "./utils.ts";

export async function loadAgentConfig(cwd: string): Promise<LoadedConfig> {
	const diagnostics: Diagnostic[] = [];
	const agents = new Map<string, LoadedAgent>();
	const builtIn = builtInGeneralAgent();
	agents.set(builtIn.canonicalName, builtIn);

	// getAgentDir() is Pi's configured global agent directory. It respects
	// PI_CODING_AGENT_DIR, so do not hardcode ~/.pi/agent here.
	const globalDir = join(getAgentDir(), "agents");
	const projectDir = join(cwd, ".pi", "agents");

	await loadScopeAgents("global", globalDir, agents, diagnostics);
	await loadScopeAgents("project", projectDir, agents, diagnostics);

	return { agents, diagnostics };
}

async function loadScopeAgents(
	scope: "global" | "project",
	dir: string,
	agents: Map<string, LoadedAgent>,
	diagnostics: Diagnostic[],
): Promise<void> {
	const files = await listYamlFiles(dir);
	const seenInScope = new Map<string, string>();

	for (const file of files) {
		let parsed: unknown;
		try {
			let fileText = (await readFile(file)).toString();
			parsed = yamlParse(fileText);
		} catch (error) {
			diagnostics.push({ type: "error", path: file, message: `Failed to parse YAML: ${formatError(error)}` });
			continue;
		}

		const validation = validateAgentDefinition(parsed, file);
		if (!validation.ok) {
			diagnostics.push(...validation.errors);
			continue;
		}

		const def = validation.agent;
		const key = canonicalizeAgentName(def.name);
		const previousInScope = seenInScope.get(key);
		if (previousInScope) {
			diagnostics.push({
				type: "warning",
				path: file,
				message: `${scope} agent "${def.name}" is also defined in ${previousInScope}; later path merges after earlier path.`,
			});
		}
		seenInScope.set(key, file);

		const existing = agents.get(key);
		if (existing) {
			const merged = deepMergeAgent(existing, def);
			agents.set(key, { ...merged, canonicalName: key, sources: [...existing.sources, file], builtIn: existing.builtIn });
		} else {
			agents.set(key, { ...def, canonicalName: key, sources: [file] });
		}
	}
}

async function listYamlFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
			.map((e) => join(dir, e.name))
			.sort();
	} catch {
		return [];
	}
}

function deepMergeAgent(base: AgentDefinition, overlay: AgentDefinition): AgentDefinition {
	const merged: AgentDefinition = { ...base, ...overlay };
	merged.models = mergeObject(base.models, overlay.models);
	merged.toolPermissions = [...(base.toolPermissions ?? []), ...(overlay.toolPermissions ?? [])];
	merged.skillPermissions = [...(base.skillPermissions ?? []), ...(overlay.skillPermissions ?? [])];
	merged.doomLoop = mergeObject(base.doomLoop, overlay.doomLoop);
	return merged;
}

function mergeObject<T extends Record<string, any> | undefined>(base: T, overlay: T): T {
	if (!base && !overlay) return undefined as T;
	if (!base) return overlay;
	if (!overlay) return base;
	return { ...base, ...overlay } as T;
}

function validateAgentDefinition(value: unknown, path: string): { ok: true; agent: AgentDefinition } | { ok: false; errors: Diagnostic[] } {
	try {
		let agent: AgentDefinition = AgentSchema.parse(value);
		return { ok: true, agent: agent };
	} catch (error) {
		if (error instanceof z.ZodError) {
			let errors = error.issues.map(val => {
				return {
					type: "error",
					path: path,
					message: `${val.path}: ${val.message}`
				} as Diagnostic;
			});
			return { ok: false, errors: errors };
		}
		return {
			ok: false, errors: [
				{
					type: "error",
					path: path,
					message: "Unhandled exception when parsing agent definition."
				}]
		}
	}
}
