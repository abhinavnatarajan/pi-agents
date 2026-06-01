import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export type AgentKeybindingAction = "app.agent.select" | "app.agent.cycleForward" | "app.agent.cycleBackward";

export const agentKeybindingActions: Record<AgentKeybindingAction, string> = {
	"app.agent.select": "Select active agent",
	"app.agent.cycleForward": "Cycle to next agent",
	"app.agent.cycleBackward": "Cycle to previous agent",
};

export function loadAgentActionKeybindings(): Array<{ action: AgentKeybindingAction; key: KeyId; description: string }> {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return [];

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		console.warn(`Agent system: failed to read keybindings from ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
	const config = raw as Record<string, unknown>;
	const bindings: Array<{ action: AgentKeybindingAction; key: KeyId; description: string }> = [];
	for (const [action, description] of Object.entries(agentKeybindingActions) as Array<[AgentKeybindingAction, string]>) {
		for (const key of normalizeKeyList(config[action])) {
			bindings.push({ action, key: key as KeyId, description });
		}
	}
	return bindings;
}

function normalizeKeyList(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (Array.isArray(value)) return value.filter((key): key is string => typeof key === "string" && key.trim().length > 0).map((key) => key.trim());
	return [];
}
