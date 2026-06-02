import { LoadedAgent, MatchesAny, PathInAny, SkillPermission, ToolPermission } from "./types.ts";


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
].map(t => new RegExp(t));

export function builtInGeneralAgent() : LoadedAgent {
	return {
		canonicalName: "general",
		builtIn: true,
		sources: [ "<built-in>" ],
		name: "General",
		description: "General-purpose coding assistant with conservative permissions.",
		prompt: "You are the General agent. Be concise and careful.",
		toolPermissions: [
			new ToolPermission([ /\*/ ], "deny"),
			new ToolPermission([ /^read$/, /^grep$/, /^find$/, /^ls$/ ], "allow", [ new PathInAny("path", [ "<env:cwd>" ]) ]),
			new ToolPermission([ /^write$/, /^edit$/ ], "ask", [ new PathInAny("path", [ "<env:cwd>" ]) ]),
			new ToolPermission([ /^bash$/ ], "ask"),
			new ToolPermission([ /^bash$/ ], "deny", [ new MatchesAny("command", dangerousGeneralCommands) ])
		],
		skillPermissions: [
			new SkillPermission([ /\.*/ ], "deny"),
		],
		doomLoop: { threshold: 3, permission: "ask" },
	};
}
