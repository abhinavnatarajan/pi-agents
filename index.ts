import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	formatSkillsForPrompt,
	getAgentDir,
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type InputEvent,
	type Skill,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_STATE_TYPE = "agent-system-state";
const STATUS_KEY = "agent";

type Permission = "allow" | "ask" | "deny";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type MatchSpec = string | string[] | { regex: string };

interface Rule {
	match: MatchSpec;
	permission: Permission;
	when?: Record<string, ConditionSpec>;
	mcp?: { server?: string; tool?: string };
	reason?: string;
}

interface ConditionSpec {
	field?: string;
	withinCwd?: boolean;
	outsideCwd?: boolean;
	matchesAny?: string[];
	notMatchesAny?: string[];
	startsWithAny?: string[];
	equals?: unknown;
	contains?: unknown;
	in?: unknown[];
	matches?: string;
	exists?: boolean;
}

interface AgentDefinition {
	name: string;
	description: string;
	models?: {
		default?: string;
		fallbacks?: string[];
		thinking?: ThinkingLevel;
	};
	prompt?: string;
	tools?: { rules?: Rule[] };
	skills?: { rules?: Rule[] };
	doomLoop?: {
		threshold?: number;
		permission?: Permission;
	};
}

interface LoadedAgent extends AgentDefinition {
	canonicalName: string;
	sources: string[];
	builtIn?: boolean;
}

interface Diagnostic {
	type: "warning" | "error";
	message: string;
	path?: string;
}

interface LoadedConfig {
	agents: Map<string, LoadedAgent>;
	diagnostics: Diagnostic[];
}

interface Decision {
	permission: Permission;
	rule?: Rule;
	reason?: string;
}

interface RunState {
	agentKey: string;
	doomCounts: Map<string, number>;
}

const dangerousGeneralCommands = [
	"rm",
	"sudo",
	"chmod",
	"chown",
	"dd",
	"mkfs",
	"mount",
	"umount",
	"kill",
	"pkill",
	"killall",
	"shutdown",
	"reboot",
	"ln",
	"sh",
	"bash",
	"zsh",
	"fish",
	"nushell",
	"cmd",
	"pwsh",
];

function builtInGeneralAgent(): LoadedAgent {
	return {
		canonicalName: "general",
		builtIn: true,
		sources: ["<built-in>"],
		name: "General",
		description: "General-purpose coding assistant with conservative permissions.",
		models: { default: "*", fallbacks: [], thinking: undefined },
		prompt: "You are the General agent. Be concise and careful.",
		tools: {
			rules: [
				{ match: "*", permission: "deny" },
				{ match: "read", permission: "allow", when: { path: { field: "path", withinCwd: true } } },
				{ match: ["grep", "find", "ls"], permission: "allow", when: { path: { field: "path", withinCwd: true } } },
				{ match: ["write", "edit"], permission: "ask", when: { path: { field: "path", withinCwd: true } } },
				{ match: "bash", permission: "ask" },
				{
					match: "bash",
					permission: "deny",
					when: { command: { field: "command", startsWithAny: dangerousGeneralCommands } },
					reason: "Dangerous bash command denied by the General agent.",
				},
			],
		},
		skills: { rules: [{ match: "*", permission: "deny" }] },
		doomLoop: { threshold: 3, permission: "ask" },
	};
}

function canonicalizeAgentName(name: string): string {
	return name.trim().toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function loadYamlLibrary(): Promise<{ parse: (text: string) => unknown }> {
	try {
		return (await import("yaml")) as { parse: (text: string) => unknown };
	} catch {}

	const require = createRequire(import.meta.url);
	try {
		return require("yaml") as { parse: (text: string) => unknown };
	} catch {}

	const homePiYaml = process.env.HOME
		? join(process.env.HOME, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "yaml")
		: undefined;
	if (homePiYaml) {
		try {
			return require(homePiYaml) as { parse: (text: string) => unknown };
		} catch {}
	}

	throw new Error("Unable to load YAML parser. Run `npm install` in the agent-system extension directory to install the `yaml` dependency.");
}

async function loadAgentConfig(cwd: string): Promise<LoadedConfig> {
	const diagnostics: Diagnostic[] = [];
	const agents = new Map<string, LoadedAgent>();
	const builtIn = builtInGeneralAgent();
	agents.set(builtIn.canonicalName, builtIn);

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
		if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(value.thinking))) {
			errors.push({ type: "error", path, message: "`models.thinking` must be one of off, minimal, low, medium, high, xhigh." });
		} else {
			result.thinking = value.thinking as ThinkingLevel;
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
		permission: value.permission as Permission,
		when: value.when as Record<string, ConditionSpec> | undefined,
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
			result.permission = value.permission as Permission;
		}
	}
	return result;
}

function matchesRuleName(match: MatchSpec, name: string): boolean {
	if (typeof match === "string") return match === "*" || match === name;
	if (Array.isArray(match)) return match.includes(name);
	try {
		return new RegExp(match.regex).test(name);
	} catch {
		return false;
	}
}

function evaluateRules(rules: Rule[] | undefined, targetName: string, input: Record<string, unknown>, ctx: ExtensionContext): Decision {
	let decision: Decision = { permission: "deny", reason: "No matching permission rule." };
	for (const rule of rules ?? []) {
		if (!matchesRuleName(rule.match, targetName)) continue;
		if (!matchesMcp(rule, input)) continue;
		if (!conditionsMatch(rule.when, input, ctx)) continue;
		decision = { permission: rule.permission, rule, reason: rule.reason };
	}
	return decision;
}

function shouldExposeTool(agent: LoadedAgent, toolName: string): boolean {
	const matching = (agent.tools?.rules ?? []).filter((rule) => matchesRuleName(rule.match, toolName));
	for (let i = matching.length - 1; i >= 0; i--) {
		const rule = matching[i]!;
		if (rule.permission === "deny" && !rule.when && !rule.mcp) return false;
		if (rule.permission === "allow" || rule.permission === "ask") return true;
		// Conditional deny: keep scanning earlier matching rules.
	}
	return false;
}

function matchesMcp(rule: Rule, input: Record<string, unknown>): boolean {
	if (!rule.mcp) return true;
	const server = stringFromUnknown(input.server ?? input.serverName ?? input.mcpServer ?? input.mcp_server);
	const tool = stringFromUnknown(input.tool ?? input.toolName ?? input.mcpTool ?? input.mcp_tool ?? input.name);
	if (rule.mcp.server !== undefined && rule.mcp.server !== server) return false;
	if (rule.mcp.tool !== undefined && rule.mcp.tool !== tool) return false;
	return true;
}

function stringFromUnknown(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function conditionsMatch(when: Record<string, ConditionSpec> | undefined, input: Record<string, unknown>, ctx: ExtensionContext): boolean {
	if (!when) return true;
	for (const [conditionName, condition] of Object.entries(when)) {
		if (!isPlainObject(condition)) return false;
		const field = typeof condition.field === "string" ? condition.field : conditionName;
		const rawValue = getFieldValue(input, field);
		if (!conditionMatches(condition, rawValue, ctx)) return false;
	}
	return true;
}

function getFieldValue(input: Record<string, unknown>, field: string): unknown {
	const parts = field.split(".");
	let current: unknown = input;
	for (const part of parts) {
		if (!isPlainObject(current) || !(part in current)) {
			return field === "path" ? "." : undefined;
		}
		current = current[part];
	}
	return current;
}

function conditionMatches(condition: ConditionSpec, rawValue: unknown, ctx: ExtensionContext): boolean {
	if (condition.exists !== undefined) {
		const exists = rawValue !== undefined && rawValue !== null;
		if (exists !== condition.exists) return false;
	}
	if (condition.withinCwd !== undefined || condition.outsideCwd !== undefined) {
		const normalized = normalizePermissionPath(String(rawValue ?? "."), ctx.cwd);
		const inside = isWithinCwd(normalized, ctx.cwd);
		if (condition.withinCwd !== undefined && inside !== condition.withinCwd) return false;
		if (condition.outsideCwd !== undefined && !inside !== condition.outsideCwd) return false;
	}
	if (condition.startsWithAny) {
		const executable = firstExecutableToken(String(rawValue ?? ""));
		if (!executable || !condition.startsWithAny.includes(executable)) return false;
	}
	if (condition.matchesAny) {
		const value = String(rawValue ?? "");
		if (!condition.matchesAny.some((pattern) => patternMatches(pattern, value))) return false;
	}
	if (condition.notMatchesAny) {
		const value = String(rawValue ?? "");
		if (condition.notMatchesAny.some((pattern) => patternMatches(pattern, value))) return false;
	}
	if (condition.equals !== undefined && rawValue !== condition.equals) return false;
	if (condition.contains !== undefined) {
		if (typeof rawValue === "string") {
			if (!rawValue.includes(String(condition.contains))) return false;
		} else if (Array.isArray(rawValue)) {
			if (!rawValue.includes(condition.contains)) return false;
		} else {
			return false;
		}
	}
	if (condition.in !== undefined && !condition.in.includes(rawValue)) return false;
	if (condition.matches !== undefined && !patternMatches(condition.matches, String(rawValue ?? ""))) return false;
	return true;
}

function patternMatches(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern).test(value);
	} catch {
		return globLikeToRegExp(pattern).test(value);
	}
}

function globLikeToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

function normalizePermissionPath(rawPath: string, cwd: string): string {
	const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	const absolute = isAbsolute(withoutAt) ? withoutAt : resolve(cwd, withoutAt);
	return resolve(absolute);
}

function isWithinCwd(absolutePath: string, cwd: string): boolean {
	const rel = relative(resolve(cwd), absolutePath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function canonicalizeForExistingPath(absolutePath: string): Promise<string> {
	try {
		return await realpath(absolutePath);
	} catch {
		return absolutePath;
	}
}

function firstExecutableToken(command: string): string | undefined {
	const tokens = shellishSplit(command.trim());
	for (const token of tokens) {
		if (!token) continue;
		if (token.includes("=") && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
		return basename(token);
	}
	return undefined;
}

function shellishSplit(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const ch of command) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		if ([";", "|", "&", "<", ">"].includes(ch)) break;
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function stableJson(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function stricterPermission(normal: Permission, doom: Permission): Permission {
	if (normal === "deny" || doom === "deny") return "deny";
	if (normal === "ask" || doom === "ask") return "ask";
	return "allow";
}

function permissionRank(permission: Permission): number {
	return permission === "allow" ? 0 : permission === "ask" ? 1 : 2;
}

function applyDoomLoop(agent: LoadedAgent, runState: RunState, toolName: string, input: Record<string, unknown>, decision: Decision): Decision {
	if (decision.permission === "deny") return decision;
	const threshold = agent.doomLoop?.threshold;
	if (!threshold || threshold < 1) return decision;
	const key = `${toolName}\0${stableJson(input)}`;
	const next = (runState.doomCounts.get(key) ?? 0) + 1;
	runState.doomCounts.set(key, next);
	if (next < threshold) return decision;
	const doomPermission = agent.doomLoop?.permission ?? "ask";
	const permission = stricterPermission(decision.permission, doomPermission);
	if (permissionRank(permission) <= permissionRank(decision.permission)) return decision;
	return {
		permission,
		rule: decision.rule,
		reason: `Doom-loop protection: ${toolName} was called with identical input ${next} time(s).`,
	};
}

async function askPermission(ctx: ExtensionContext, agent: LoadedAgent, kind: "tool" | "skill", name: string, details: unknown, reason?: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const renderedDetails = safeJson(details);
	return await ctx.ui.confirm(
		`Agent permission: ${agent.name}`,
		[
			`Allow ${kind} "${name}" once?`,
			reason ? `Reason: ${reason}` : undefined,
			renderedDetails ? `Details:\n${renderedDetails}` : undefined,
		]
			.filter(Boolean)
			.join("\n\n"),
	);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function buildPermissionsSummary(agent: LoadedAgent): string {
	const exposed = (agent.tools?.rules ?? [])
		.filter((r) => r.permission !== "deny")
		.map((r) => formatMatch(r.match))
		.slice(0, 20);
	const allowedSkills = (agent.skills?.rules ?? [])
		.filter((r) => r.permission !== "deny")
		.map((r) => formatMatch(r.match))
		.slice(0, 20);
	return [
		`Active Pi agent: ${agent.name}`,
		"Only use tools and skills permitted by the active agent. If a tool or skill is denied, choose another safe approach or ask the user.",
		`Potentially permitted tools: ${exposed.length > 0 ? exposed.join(", ") : "none"}.`,
		`Potentially permitted skills: ${allowedSkills.length > 0 ? allowedSkills.join(", ") : "none"}.`,
	].join("\n");
}

function formatMatch(match: MatchSpec): string {
	if (typeof match === "string") return match;
	if (Array.isArray(match)) return match.join("|");
	return `/${match.regex}/`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function findRestoredAgentKey(ctx: ExtensionContext, agents: Map<string, LoadedAgent>): string | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: { name?: string } };
		if (entry.type === "custom" && entry.customType === EXTENSION_STATE_TYPE && typeof entry.data?.name === "string") {
			const key = canonicalizeAgentName(entry.data.name);
			if (agents.has(key)) return key;
			return undefined;
		}
	}
	return undefined;
}

function formatAgentList(agents: Map<string, LoadedAgent>, selectedKey: string): string {
	const list = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
	return list.map((agent) => `${agent.canonicalName === selectedKey ? "*" : " "} ${agent.name} - ${agent.description}`).join("\n");
}

function skillNameFromInput(text: string): string | undefined {
	if (!text.startsWith("/skill:")) return undefined;
	const spaceIndex = text.indexOf(" ");
	const name = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
	return name.trim() || undefined;
}

function emitNoUiText(pi: ExtensionAPI, text: string): void {
	if (isLikelyJsonMode()) {
		pi.sendMessage({ customType: EXTENSION_STATE_TYPE, content: text, display: true });
		return;
	}
	process.stdout.write(`${text}\n`);
}

function isLikelyJsonMode(): boolean {
	const modeIndex = process.argv.indexOf("--mode");
	return modeIndex >= 0 && process.argv[modeIndex + 1] === "json";
}

export default function agentSystemExtension(pi: ExtensionAPI) {
	let config: LoadedConfig = { agents: new Map([["general", builtInGeneralAgent()]]), diagnostics: [] };
	let selectedAgentKey = "general";
	let runtimeAppliedAgentKey: string | undefined;
	let runState: RunState | undefined;

	function getSelectedAgent(): LoadedAgent {
		return config.agents.get(selectedAgentKey) ?? config.agents.get("general") ?? builtInGeneralAgent();
	}

	function getRunAgent(): LoadedAgent {
		return config.agents.get(runState?.agentKey ?? selectedAgentKey) ?? getSelectedAgent();
	}

	function updateStatus(ctx: ExtensionContext): void {
		const agent = getSelectedAgent();
		ctx.ui.setStatus(STATUS_KEY, `use agent: ${agent.name}`);
	}

	async function notifyDiagnostics(ctx: ExtensionContext): Promise<void> {
		for (const diagnostic of config.diagnostics) {
			const message = `${diagnostic.path ? `${diagnostic.path}: ` : ""}${diagnostic.message}`;
			ctx.ui.notify(message, diagnostic.type === "error" ? "error" : "warning");
		}
	}

	async function applyAgentRuntime(agent: LoadedAgent, ctx: ExtensionContext): Promise<void> {
		const allTools = pi.getAllTools();
		const activeTools = allTools.filter((tool) => shouldExposeTool(agent, tool.name)).map((tool) => tool.name);
		pi.setActiveTools(activeTools);

		if (agent.models?.default && agent.models.default !== "*") {
			const selected = await selectConfiguredModel(agent, ctx);
			if (!selected) {
				ctx.ui.notify(`Agent "${agent.name}": no configured model/fallback is available; keeping current model.`, "warning");
			}
		}
		if (agent.models?.thinking) {
			pi.setThinkingLevel(agent.models.thinking);
		}
		runtimeAppliedAgentKey = agent.canonicalName;
	}

	async function selectConfiguredModel(agent: LoadedAgent, ctx: ExtensionContext): Promise<boolean> {
		const candidates = [agent.models?.default, ...(agent.models?.fallbacks ?? [])].filter(
			(m): m is string => typeof m === "string" && m !== "*",
		);
		for (const spec of candidates) {
			const [provider, ...modelParts] = spec.split("/");
			const modelId = modelParts.join("/");
			const model = ctx.modelRegistry.find(provider!, modelId) as Model<any> | undefined;
			if (!model) continue;
			const ok = await pi.setModel(model);
			if (ok) {
				if (spec !== agent.models?.default) ctx.ui.notify(`Agent "${agent.name}": selected fallback model ${spec}.`, "warning");
				return true;
			}
		}
		return candidates.length === 0;
	}

	async function prepareNextRun(ctx: ExtensionContext): Promise<void> {
		const agent = getSelectedAgent();
		if (runtimeAppliedAgentKey !== agent.canonicalName) {
			await applyAgentRuntime(agent, ctx);
		}
		runState = { agentKey: agent.canonicalName, doomCounts: new Map() };
	}

	async function switchAgent(key: string, ctx: ExtensionCommandContext): Promise<string> {
		const agent = config.agents.get(key);
		if (!agent) {
			const available = [...config.agents.values()].map((a) => a.name).sort().join(", ");
			const message = `Unknown agent "${key}". Available agents: ${available}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			return message;
		}
		selectedAgentKey = agent.canonicalName;
		pi.appendEntry(EXTENSION_STATE_TYPE, { name: agent.name });
		updateStatus(ctx);
		if (ctx.isIdle()) {
			await applyAgentRuntime(agent, ctx);
		}
		const message = `Using agent: ${agent.name}`;
		if (ctx.hasUI) ctx.ui.notify(message, "info");
		return message;
	}

	pi.registerCommand("agents", {
		description: "List or switch Pi agents",
		getArgumentCompletions: (prefix) =>
			[...config.agents.values()]
				.filter((agent) => agent.name.toLowerCase().startsWith(prefix.toLowerCase()))
				.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description })),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed) {
				const key = canonicalizeAgentName(trimmed);
				const message = await switchAgent(key, ctx);
				if (!ctx.hasUI) emitNoUiText(pi, message);
				return;
			}

			if (!ctx.hasUI) {
				emitNoUiText(pi, formatAgentList(config.agents, selectedAgentKey));
				return;
			}

			const options = [...config.agents.values()]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((agent) => `${agent.name} - ${agent.description}`);
			const choice = await ctx.ui.select("Select agent", options);
			if (!choice) return;
			const name = choice.split(" - ")[0]!;
			await switchAgent(canonicalizeAgentName(name), ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await loadAgentConfig(ctx.cwd);
		const restored = findRestoredAgentKey(ctx, config.agents);
		if (restored) {
			selectedAgentKey = restored;
		} else if (!config.agents.has(selectedAgentKey)) {
			selectedAgentKey = "general";
			ctx.ui.notify("Previously active agent is missing or invalid after reload; falling back to General.", "warning");
		}
		updateStatus(ctx);
		await applyAgentRuntime(getSelectedAgent(), ctx);
		await notifyDiagnostics(ctx);
	});

	pi.on("input", async (event: InputEvent, ctx) => {
		if (!event.streamingBehavior && ctx.isIdle()) {
			await prepareNextRun(ctx);
		}

		const skillName = skillNameFromInput(event.text);
		if (!skillName) return { action: "continue" as const };

		const agent = getRunAgent();
		const decision = evaluateRules(agent.skills?.rules, skillName, { name: skillName }, ctx);
		if (decision.permission === "allow") return { action: "continue" as const };
		if (decision.permission === "deny") {
			ctx.ui.notify(`Agent "${agent.name}" denied skill "${skillName}".`, "warning");
			return { action: "handled" as const };
		}
		const ok = await askPermission(ctx, agent, "skill", skillName, { skill: skillName }, decision.reason);
		if (ok) return { action: "continue" as const };
		ctx.ui.notify(`Skill "${skillName}" blocked by agent "${agent.name}".`, "warning");
		return { action: "handled" as const };
	});

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		if (!runState || runState.agentKey !== selectedAgentKey) {
			await prepareNextRun(ctx);
		}
		const agent = getRunAgent();
		let systemPrompt = event.systemPrompt;

		const allSkillsBlock = formatSkillsForPrompt(event.systemPromptOptions.skills ?? []);
		if (allSkillsBlock) {
			const allowedSkills = (event.systemPromptOptions.skills ?? []).filter((skill: Skill) => {
				const decision = evaluateRules(agent.skills?.rules, skill.name, { name: skill.name }, ctx);
				return decision.permission === "allow" || decision.permission === "ask";
			});
			const allowedSkillsBlock = formatSkillsForPrompt(allowedSkills);
			systemPrompt = systemPrompt.split(allSkillsBlock).join(allowedSkillsBlock);
		}

		const additions = [agent.prompt?.trim(), buildPermissionsSummary(agent)].filter((s): s is string => !!s);
		if (additions.length > 0) systemPrompt += `\n\n${additions.join("\n\n")}`;
		return { systemPrompt };
	});

	pi.on("agent_end", async () => {
		runState = undefined;
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		const agent = getRunAgent();
		if (!runState) runState = { agentKey: agent.canonicalName, doomCounts: new Map() };

		// Canonicalize existing filesystem paths for permission checks where possible, without mutating tool input.
		const input = event.input as Record<string, unknown>;
		const decision = applyDoomLoop(
			agent,
			runState,
			event.toolName,
			input,
			evaluateRules(agent.tools?.rules, event.toolName, input, ctx),
		);

		if (decision.permission === "allow") return undefined;
		if (decision.permission === "deny") {
			return { block: true, reason: decision.reason ?? `Agent "${agent.name}" denied tool "${event.toolName}".` };
		}
		const ok = await askPermission(ctx, agent, "tool", event.toolName, input, decision.reason);
		if (!ok) return { block: true, reason: `Agent "${agent.name}" blocked tool "${event.toolName}".` };
		return undefined;
	});
}
