import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { builtInGeneralAgent } from "./default-agent.ts";
import type { AgentDefinition, AgentThinking, Diagnostic, LoadedAgent, LoadedConfig, MatchSpec, Rule } from "./types.ts";
import { canonicalizeAgentName, formatError, isPlainObject, loadYamlLibrary } from "./utils.ts";

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
			parsed = await parseYamlFile(file);
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

async function parseYamlFile(filePath: string): Promise<unknown> {
	const content = await readFile(filePath, "utf8");
	const yaml = await loadYamlLibrary();
	return yaml.parse(content);
}

function deepMergeAgent(base: AgentDefinition, overlay: AgentDefinition): AgentDefinition {
	const merged: AgentDefinition = { ...base, ...overlay };
	merged.models = mergeObject(base.models, overlay.models);
	merged.tools = { rules: [...(base.tools?.rules ?? []), ...(overlay.tools?.rules ?? [])] };
	merged.skills = { rules: [...(base.skills?.rules ?? []), ...(overlay.skills?.rules ?? [])] };
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
	const errors: Diagnostic[] = [];
	if (!isPlainObject(value)) {
		return { ok: false, errors: [{ type: "error", path, message: "Agent definition must be a YAML object." }] };
	}

	const name = value.name;
	const description = value.description;
	if (typeof name !== "string" || name.trim().length === 0) {
		errors.push({ type: "error", path, message: "Agent field `name` is required and must be a non-empty string." });
	}
	if (typeof description !== "string" || description.trim().length === 0) {
		errors.push({ type: "error", path, message: "Agent field `description` is required and must be a non-empty string." });
	}

	const models = validateModels(value.models, path, errors);
	const tools = validateRuleBlock(value.tools, "tools", path, errors);
	const skills = validateRuleBlock(value.skills, "skills", path, errors);
	const doomLoop = validateDoomLoop(value.doomLoop, path, errors);

	if (value.prompt !== undefined && typeof value.prompt !== "string") {
		errors.push({ type: "error", path, message: "Agent field `prompt` must be a string when present." });
	}

	if (errors.some((e) => e.type === "error")) return { ok: false, errors };

	return {
		ok: true,
		agent: {
			name: name as string,
			description: description as string,
			models,
			prompt: typeof value.prompt === "string" ? value.prompt : undefined,
			tools,
			skills,
			doomLoop,
		},
	};
}

function validateModels(value: unknown, path: string, errors: Diagnostic[]): AgentDefinition["models"] {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		errors.push({ type: "error", path, message: "`models` must be an object." });
		return undefined;
	}

	const result: AgentDefinition["models"] = {};
	if (value.default !== undefined) {
		if (typeof value.default !== "string" || !isValidDefaultModelString(value.default)) {
			errors.push({ type: "error", path, message: "`models.default` must be `*` or an exact `provider/model-id` string." });
		} else {
			result.default = value.default;
		}
	}
	if (value.fallbacks !== undefined) {
		if (!Array.isArray(value.fallbacks) || value.fallbacks.some((m) => typeof m !== "string" || !isExactModelString(m))) {
			errors.push({ type: "error", path, message: "`models.fallbacks` must be exact `provider/model-id` strings; `*` is not valid there." });
		} else {
			result.fallbacks = value.fallbacks as string[];
		}
	}
	if (value.thinking !== undefined) {
		if (!["*", "off", "minimal", "low", "medium", "high", "xhigh"].includes(String(value.thinking))) {
			errors.push({ type: "error", path, message: "`models.thinking` must be `*` or one of off, minimal, low, medium, high, xhigh." });
		} else {
			result.thinking = value.thinking as AgentThinking;
		}
	}
	return result;
}

function isValidDefaultModelString(value: string): boolean {
	return value === "*" || isExactModelString(value);
}

function isExactModelString(value: string): boolean {
	if (value.includes("*")) return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

function validateRuleBlock(value: unknown, blockName: "tools" | "skills", path: string, errors: Diagnostic[]): { rules?: Rule[] } | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		errors.push({ type: "error", path, message: `\`${blockName}\` must be an object.` });
		return undefined;
	}
	if (value.rules === undefined) return {};
	if (!Array.isArray(value.rules)) {
		errors.push({ type: "error", path, message: `\`${blockName}.rules\` must be an array.` });
		return undefined;
	}

	const rules: Rule[] = [];
	value.rules.forEach((ruleValue, index) => {
		const rule = validateRule(ruleValue, `${blockName}.rules[${index}]`, path, errors);
		if (rule) rules.push(rule);
	});
	return { rules };
}

function validateRule(value: unknown, label: string, path: string, errors: Diagnostic[]): Rule | undefined {
	if (!isPlainObject(value)) {
		errors.push({ type: "error", path, message: `\`${label}\` must be an object.` });
		return undefined;
	}
	if (!isValidMatchSpec(value.match)) {
		errors.push({ type: "error", path, message: `\`${label}.match\` must be a string, string array, or { regex: string }.` });
		return undefined;
	}
	if (!["allow", "ask", "deny"].includes(String(value.permission))) {
		errors.push({ type: "error", path, message: `\`${label}.permission\` must be allow, ask, or deny.` });
		return undefined;
	}
	if (value.when !== undefined && !isPlainObject(value.when)) {
		errors.push({ type: "error", path, message: `\`${label}.when\` must be an object when present.` });
		return undefined;
	}
	if (value.mcp !== undefined && !isPlainObject(value.mcp)) {
		errors.push({ type: "error", path, message: `\`${label}.mcp\` must be an object when present.` });
		return undefined;
	}
	return {
		match: value.match as MatchSpec,
		permission: value.permission as Rule["permission"],
		when: value.when as Record<string, any> | undefined,
		mcp: value.mcp as { server?: string; tool?: string } | undefined,
		reason: typeof value.reason === "string" ? value.reason : undefined,
	};
}

function isValidMatchSpec(value: unknown): boolean {
	if (typeof value === "string") return value.length > 0;
	if (Array.isArray(value)) return value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0);
	return isPlainObject(value) && typeof value.regex === "string" && value.regex.length > 0;
}

function validateDoomLoop(value: unknown, path: string, errors: Diagnostic[]): AgentDefinition["doomLoop"] {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		errors.push({ type: "error", path, message: "`doomLoop` must be an object." });
		return undefined;
	}
	const result: AgentDefinition["doomLoop"] = {};
	if (value.threshold !== undefined) {
		if (typeof value.threshold !== "number" || !Number.isInteger(value.threshold) || value.threshold < 1) {
			errors.push({ type: "error", path, message: "`doomLoop.threshold` must be a positive integer." });
		} else {
			result.threshold = value.threshold;
		}
	}
	if (value.permission !== undefined) {
		if (!["allow", "ask", "deny"].includes(String(value.permission))) {
			errors.push({ type: "error", path, message: "`doomLoop.permission` must be allow, ask, or deny." });
		} else {
			result.permission = value.permission as Rule["permission"];
		}
	}
	return result;
}
