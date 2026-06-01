import { basename, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expandPathLiteral, expandPathPattern, isPathField } from "./path-placeholders.ts";
import type { ConditionSpec, Decision, LoadedAgent, MatchSpec, Permission, Rule, RunState } from "./types.ts";
import { isPlainObject, safeJson } from "./utils.ts";

export function evaluateRules(rules: Rule[] | undefined, targetName: string, input: Record<string, unknown>, ctx: ExtensionContext): Decision {
	let decision: Decision = { permission: "deny", reason: "No matching permission rule." };
	for (const rule of rules ?? []) {
		if (!matchesRuleName(rule.match, targetName)) continue;
		if (!matchesMcp(rule, input)) continue;
		if (!conditionsMatch(rule.when, input, ctx)) continue;
		decision = { permission: rule.permission, rule, reason: rule.reason };
	}
	return decision;
}

export function shouldExposeTool(agent: LoadedAgent, toolName: string): boolean {
	const matching = (agent.tools?.rules ?? []).filter((rule) => matchesRuleName(rule.match, toolName));
	for (let i = matching.length - 1; i >= 0; i--) {
		const rule = matching[i]!;
		if (rule.permission === "deny" && !rule.when && !rule.mcp) return false;
		if (rule.permission === "allow" || rule.permission === "ask") return true;
		// Conditional deny: keep scanning earlier matching rules.
	}
	return false;
}

export function applyDoomLoop(agent: LoadedAgent, runState: RunState, toolName: string, input: Record<string, unknown>, decision: Decision): Decision {
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

export async function askPermission(
	ctx: ExtensionContext,
	agent: LoadedAgent,
	kind: "tool" | "skill",
	name: string,
	details: unknown,
	reason?: string,
): Promise<boolean> {
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

export function matchesRuleName(match: MatchSpec, name: string): boolean {
	if (typeof match === "string") return match === "*" || match === name;
	if (Array.isArray(match)) return match.includes(name);
	try {
		return new RegExp(match.regex).test(name);
	} catch {
		return false;
	}
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
	for (const condition of Object.values(when)) {
		if (!isPlainObject(condition) || typeof condition.field !== "string") return false;
		const rawValue = getFieldValue(input, condition.field);
		if (!conditionMatches(condition, rawValue, ctx, isPathField(condition.field))) return false;
	}
	return true;
}

function getFieldValue(input: Record<string, unknown>, field: string): unknown {
	const parts = field.split(".");
	let current: unknown = input;
	for (const part of parts) {
		if (!isPlainObject(current) || !(part in current)) {
			return undefined;
		}
		current = current[part];
	}
	return current;
}

function conditionMatches(condition: ConditionSpec, rawValue: unknown, ctx: ExtensionContext, isPathCondition: boolean): boolean {
	if (condition.exists !== undefined) {
		const exists = rawValue !== undefined && rawValue !== null;
		if (exists !== condition.exists) return false;
	}
	if (rawValue === undefined && hasNonExistsOperator(condition)) return false;
	if (isPathCondition && rawValue === null && hasNonExistsOperator(condition)) return false;

	if (condition.withinCwd !== undefined || condition.outsideCwd !== undefined) {
		const normalized = normalizePermissionPath(String(rawValue), ctx.cwd);
		const inside = isWithinCwd(normalized, ctx.cwd);
		if (condition.withinCwd !== undefined && inside !== condition.withinCwd) return false;
		if (condition.outsideCwd !== undefined && !inside !== condition.outsideCwd) return false;
	}
	if (condition.startsWithAny) {
		const executable = firstExecutableToken(String(rawValue ?? ""));
		if (!executable || !condition.startsWithAny.includes(executable)) return false;
	}
	const comparableValue = comparableConditionValue(rawValue, ctx, isPathCondition);
	if (condition.matchesAny) {
		if (!condition.matchesAny.some((pattern) => patternMatches(expandPatternForCondition(pattern, ctx, isPathCondition), comparableValue))) return false;
	}
	if (condition.notMatchesAny) {
		if (condition.notMatchesAny.some((pattern) => patternMatches(expandPatternForCondition(pattern, ctx, isPathCondition), comparableValue))) return false;
	}
	if (condition.equals !== undefined && !conditionValueEquals(rawValue, condition.equals, ctx, isPathCondition)) return false;
	if (condition.in !== undefined && !condition.in.some((value) => conditionValueEquals(rawValue, value, ctx, isPathCondition))) return false;
	return true;
}

function hasNonExistsOperator(condition: ConditionSpec): boolean {
	return (
		condition.withinCwd !== undefined ||
		condition.outsideCwd !== undefined ||
		condition.matchesAny !== undefined ||
		condition.notMatchesAny !== undefined ||
		condition.startsWithAny !== undefined ||
		condition.equals !== undefined ||
		condition.in !== undefined
	);
}

function conditionValueEquals(rawValue: unknown, expected: unknown, ctx: ExtensionContext, isPathCondition: boolean): boolean {
	if (isPathCondition) {
		if (typeof expected !== "string" || rawValue === undefined || rawValue === null) return false;
		return comparableConditionValue(rawValue, ctx, true) === comparableExpectedValue(expected, ctx, true);
	}
	return jsonDeepEqual(rawValue, expected);
}

function comparableConditionValue(rawValue: unknown, ctx: ExtensionContext, isPathCondition: boolean): string {
	if (!isPathCondition) return rawValue === undefined ? "" : String(rawValue);
	return normalizePermissionPath(String(rawValue), ctx.cwd).replace(/\\/g, "/");
}

function comparableExpectedValue(expected: unknown, ctx: ExtensionContext, isPathCondition: boolean): unknown {
	if (!isPathCondition || typeof expected !== "string") return expected;
	return normalizePermissionPath(expandPathLiteral(expected, ctx), ctx.cwd).replace(/\\/g, "/");
}

function jsonDeepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => jsonDeepEqual(value, b[index]));
	}
	if (isPlainObject(a) || isPlainObject(b)) {
		if (!isPlainObject(a) || !isPlainObject(b)) return false;
		const aEntries = Object.entries(a).filter(([, value]) => value !== undefined);
		const bEntries = Object.entries(b).filter(([, value]) => value !== undefined);
		if (aEntries.length !== bEntries.length) return false;
		return aEntries.every(([key, value]) => Object.prototype.hasOwnProperty.call(b, key) && jsonDeepEqual(value, b[key]));
	}
	return false;
}

function expandPatternForCondition(pattern: string, ctx: ExtensionContext, isPathCondition: boolean): string {
	return isPathCondition ? expandPathPattern(pattern, ctx) : pattern;
}

function patternMatches(pattern: string, value: string): boolean {
	try {
		return new RegExp(`^(?:${pattern})$`).test(value);
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
