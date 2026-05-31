export const EXTENSION_STATE_TYPE = "agent-system-state";
export const STATUS_KEY = "agent";

export type Permission = "allow" | "ask" | "deny";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type MatchSpec = string | string[] | { regex: string };

export interface Rule {
	match: MatchSpec;
	permission: Permission;
	when?: Record<string, ConditionSpec>;
	mcp?: { server?: string; tool?: string };
	reason?: string;
}

export interface ConditionSpec {
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

export interface AgentDefinition {
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

export interface LoadedAgent extends AgentDefinition {
	canonicalName: string;
	sources: string[];
	builtIn?: boolean;
}

export interface Diagnostic {
	type: "warning" | "error";
	message: string;
	path?: string;
}

export interface LoadedConfig {
	agents: Map<string, LoadedAgent>;
	diagnostics: Diagnostic[];
}

export interface Decision {
	permission: Permission;
	rule?: Rule;
	reason?: string;
}

export interface RunState {
	agentKey: string;
	doomCounts: Map<string, number>;
}
