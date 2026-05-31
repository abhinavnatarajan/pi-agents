import { formatSkillsForPrompt, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import type { LoadedAgent, MatchSpec } from "./types.ts";
import { evaluateRules } from "./permissions.ts";

export function buildPermissionsSummary(agent: LoadedAgent): string {
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

export function filterSkillPromptBlock(systemPrompt: string, skills: Skill[] | undefined, agent: LoadedAgent, ctx: ExtensionContext): string {
	const allSkills = skills ?? [];
	const allSkillsBlock = formatSkillsForPrompt(allSkills);
	if (!allSkillsBlock) return systemPrompt;

	const allowedSkills = allSkills.filter((skill) => {
		const decision = evaluateRules(agent.skills?.rules, skill.name, { name: skill.name }, ctx);
		return decision.permission === "allow" || decision.permission === "ask";
	});
	const allowedSkillsBlock = formatSkillsForPrompt(allowedSkills);
	return systemPrompt.split(allSkillsBlock).join(allowedSkillsBlock);
}

function formatMatch(match: MatchSpec): string {
	if (typeof match === "string") return match;
	if (Array.isArray(match)) return match.join("|");
	return `/${match.regex}/`;
}
