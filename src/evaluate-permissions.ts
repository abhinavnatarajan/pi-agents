import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { Decision, LoadedAgent, Permission, RunState, SkillPermission, ToolPermission } from "./types.ts";
import { safeJson } from "./utils.ts";

export function evalToolPermissions(
	rules : ToolPermission[] | undefined,
	tool : string,
	params : Record<string, unknown>,
	ctx : ExtensionContext
) : Decision {
	if(rules != undefined) {
		for(let i = rules.length - 1; i >= 0; i--) {
			let currentRule = rules[ i ]!;
			const decision = currentRule.evalToolCall(tool, params, ctx);
			// Decision is undefined if and only if none of the rule conditions apply
			if(decision != undefined) return decision;
		}
	}
	return { permission: "deny", reason: "No matching permission rule." };
}

export function evalSkillPermissions(
	rules : SkillPermission[] | undefined,
	skill : string,
) : Decision {
	if(rules != undefined) {
		for(let i = rules.length - 1; i >= 0; i--) {
			let currentRule = rules[ i ]!;
			const decision = currentRule.evalSkillCall(skill);
			// Decision is undefined if and only if none of the rule conditions apply
			if(decision != undefined) return decision;
		}
	}
	return { permission: "deny", reason: "No matching permission rule." };
}

export function shouldExposeTool(agent : LoadedAgent, tool : string) : boolean {
	const matching = (agent.toolPermissions ?? []).filter((rule) => rule.matchesTool(tool));
	for(let i = matching.length - 1; i >= 0; i--) {
		const rule = matching[ i ]!;
		if(rule.permission === "deny" && !rule.conditions) return false;
		if(rule.permission === "allow" || rule.permission === "ask") return true;
		// Conditional deny: keep scanning earlier matching rules.
	}
	return false;
}

export function shouldExposeSkill(agent : LoadedAgent, skill : string) : boolean {
	const lastMatchingRule = (agent.skillPermissions ?? []).filter((rule) => rule.matchesSkill(skill)).at(-1);
	if(lastMatchingRule != undefined) return !(lastMatchingRule.permission === "deny");
	return false;
}
export function applyDoomLoop(
	agent : LoadedAgent,
	runState : RunState,
	toolName : string,
	input : Record<string, unknown>,
	decision : Decision
) : Decision {
	if(decision.permission === "deny") return decision;
	const threshold = agent.doomLoop?.threshold;
	if(!threshold || threshold < 1) return decision;

	const key = `${toolName}\0${stableJson(input)}`;
	const next = (runState.doomCounts.get(key) ?? 0) + 1;
	runState.doomCounts.set(key, next);
	if(next < threshold) return decision;

	const doomPermission = agent.doomLoop?.permission ?? "ask";
	const permission = stricterPermission(decision.permission, doomPermission);
	if(permissionRank(permission) <= permissionRank(decision.permission)) return decision;

	return {
		permission,
		reason: `Doom-loop protection: ${toolName} was called with identical input ${next} time(s).`,
	};
}

export async function askPermission(
	ctx : ExtensionContext,
	agent : LoadedAgent,
	kind : "tool" | "skill",
	name : string,
	details : unknown,
) : Promise<boolean> {
	if(!ctx.hasUI) return false;
	const renderedDetails = safeJson(details);
	return await ctx.ui.confirm(
		`Agent permission: ${agent.name}`,
		[
			`Allow ${kind} "${name}" once?`,
			renderedDetails ? `Details:\n${renderedDetails}` : undefined,
		]
			.filter(Boolean)
			.join("\n\n"),
	);
}

function firstExecutableToken(command : string) : string | undefined {
	const tokens = shellishSplit(command.trim());
	for(const token of tokens) {
		if(!token) continue;
		if(token.includes("=") && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
		return basename(token);
	}
	return undefined;
}

function shellishSplit(command : string) : string[] {
	const tokens : string[] = [];
	let current = "";
	let quote : "'" | '"' | undefined;
	let escaped = false;
	for(const ch of command) {
		if(escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if(ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if(quote) {
			if(ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if(ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if(/\s/.test(ch)) {
			if(current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		if([ ";", "|", "&", "<", ">" ].includes(ch)) break;
		current += ch;
	}
	if(current) tokens.push(current);
	return tokens;
}

function stableJson(value : unknown) : string {
	if(value === undefined) return "undefined";
	if(value === null || typeof value !== "object") return JSON.stringify(value);
	if(Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([ , v ]) => v !== undefined)
		.sort(([ a ], [ b ]) => a.localeCompare(b));
	return `{${entries.map(([ k, v ]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function stricterPermission(normal : Permission, doom : Permission) : Permission {
	if(normal === "deny" || doom === "deny") return "deny";
	if(normal === "ask" || doom === "ask") return "ask";
	return "allow";
}

function permissionRank(permission : Permission) : number {
	return permission === "allow" ? 0 : permission === "ask" ? 1 : 2;
}
