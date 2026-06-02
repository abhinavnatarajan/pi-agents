import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXTENSION_STATE_TYPE, type LoadedAgent } from "./types.ts";
import { canonicalizeAgentName } from "./utils.ts";

export function findRestoredAgentKey(ctx : ExtensionContext, agents : Map<string, LoadedAgent>) : string | undefined {
	const entries = ctx.sessionManager.getBranch();
	for(let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[ i ] as { type ?: string; customType ?: string; data ?: { name ?: string; }; };
		if(entry.type === "custom" && entry.customType === EXTENSION_STATE_TYPE && typeof entry.data?.name === "string") {
			const key = canonicalizeAgentName(entry.data.name);
			if(agents.has(key)) return key;
			return undefined;
		}
	}
	return undefined;
}

export function formatAgentList(agents : Map<string, LoadedAgent>, selectedKey : string) : string {
	const list = [ ...agents.values() ].sort((a, b) => a.name.localeCompare(b.name));
	return list.map((agent) => `${agent.canonicalName === selectedKey ? "*" : " "} ${agent.name} - ${agent.description}`).join("\n");
}

export function skillNameFromInput(text : string) : string | undefined {
	if(!text.startsWith("/skill:")) return undefined;
	const spaceIndex = text.indexOf(" ");
	const name = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
	return name.trim() || undefined;
}
