import type { LoadedAgent } from "./types.ts";

export const dangerousGeneralCommands = [
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

export function builtInGeneralAgent(): LoadedAgent {
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
