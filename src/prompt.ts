import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import type { LoadedAgent } from "./types.ts";
import { evalSkillPermissions } from "./evaluate-permissions.ts";

export function filterSkillPromptBlock(systemPrompt: string, skills: Skill[] | undefined, agent: LoadedAgent): string {
	const allSkills = skills ?? [];
	const allSkillsBlock = formatSkillsForPrompt(allSkills);
	if (!allSkillsBlock) return systemPrompt;

	const allowedSkills = allSkills.filter((skill) => {
		const decision = evalSkillPermissions(agent.skillPermissions, skill.name);
		return decision.permission === "allow" || decision.permission === "ask";
	});
	const allowedSkillsBlock = formatSkillsForPrompt(allowedSkills);
	return systemPrompt.split(allSkillsBlock).join(allowedSkillsBlock);
}
