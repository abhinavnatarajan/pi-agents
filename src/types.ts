import z from "zod";
import { Condition, ConditionResult, ConditionSchema } from "./conditions.ts";
export * from "./conditions.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getNestedFieldValue } from "./utils.ts";
export { ConditionResult, ConditionSchema } from "./conditions.ts";
export const EXTENSION_STATE_TYPE = "agent-system-state";
export const STATUS_KEY = "agent";

const NonEmptyString = z.string().trim().min(1)
const AgentThinkingSchema = z.union([
	z.literal("off"),
	z.literal("minimal"),
	z.literal("low"),
	z.literal("medium"),
	z.literal("high"),
	z.literal("xhigh"),
]).default("medium");
const ModelSchema = z.object({
	provider: NonEmptyString,
	modelId: NonEmptyString,
	thinking: AgentThinkingSchema.optional()
})
const PermissionSchema = z.union([z.literal("allow"), z.literal("ask"), z.literal("deny")]);
export type Permission = z.infer<typeof PermissionSchema>;

const ToolOrSkillNamePatternsSchema = z.union([NonEmptyString, z.array(NonEmptyString).min(1)]).transform((val, ctx) => {
	if (typeof (val) === "string") val = [val];
	return val.map((pattern) => {
		try {
			return new RegExp(`^(?:${pattern})$`);
		} catch {
			ctx.issues.push({
				message: "Invalid regular expression.",
				input: pattern,
				code: "custom"
			})
			return null;
		}
	}).filter((regexp) => regexp != null);
});

export class ToolPermission {
	matchPatterns: RegExp[];
	permission: Permission;
	conditions?: Condition[];
	constructor(matchPatterns: RegExp[], permission: Permission, conditions?: Condition[]) {
		this.matchPatterns = matchPatterns;
		this.permission = permission;
		this.conditions = conditions;
	}
	matchesTool(tool: string) {
		return this.matchPatterns.some((regexp) => regexp.test(tool));
	}
	evalToolCall(tool: string, params: Record<string, unknown>, ctx: ExtensionContext): Decision | undefined {
		if (!this.matchesTool(tool)) return undefined;
		if (this.conditions == null) {
			if (this.permission === "deny") {
				return {
					permission: "deny",
					reason: `Tool "${tool}" denied.`
				}
			}
			return {
				permission: this.permission,
			};
		}
		let result = this.conditions.reduce(
			(currentResult, cond) => currentResult.andThen(
				() => cond.eval(getNestedFieldValue(params, cond.field), ctx)
			),
			new ConditionResult(true)
		);
		// Some condition in the rule matches the call
		if (result.ok) return {
			permission: this.permission,
			reason: this.permission === "deny" ? result.reason : undefined,
		};
		// Otherwise the rule does not apply
		return undefined;
	}
}
const ToolPermissionSchema = z.object({
	matchPatterns: ToolOrSkillNamePatternsSchema,
	permission: PermissionSchema,
	conditions: z.array(ConditionSchema).min(1).optional(),
}).transform(val => new ToolPermission(val.matchPatterns, val.permission, val.conditions));

export class SkillPermission {
	matchPatterns: RegExp[];
	permission: Permission;
	constructor(matchPatterns: RegExp[], permission: Permission) {
		this.matchPatterns = matchPatterns;
		this.permission = permission;
	}
	matchesSkill(skill: string) {
		return this.matchPatterns.some((regexp) => regexp.test(skill));
	}
	evalSkillCall(skill: string) {
		if (!this.matchesSkill(skill)) return undefined;
		return {
			permission: this.permission,
			reason: this.permission === "deny" ? `Skill "${skill}" not allowed.` : undefined,
		}
	}
}
const SkillPermissionSchema = z.object({
	matchPatterns: ToolOrSkillNamePatternsSchema,
	permission: PermissionSchema
}).transform(val => new SkillPermission(val.matchPatterns, val.permission));

export const AgentSchema = z.object({
	name: z.string(),
	description: z.string(),
	models: z.object({
		default: ModelSchema,
		fallbacks: z.array(ModelSchema).min(1).optional(),
	}).optional(),
	prompt: z.string().optional(),
	toolPermissions: z.array(ToolPermissionSchema).min(1).optional(),
	skillPermissions: z.array(SkillPermissionSchema).min(1).optional(),
	doomLoop: z.object({
		threshold: z.number(),
		permission: PermissionSchema.optional()
	}).optional()
});
export type AgentDefinition = z.infer<typeof AgentSchema>;

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

export type Decision = {
	permission: Permission
	reason?: string;
};

export interface RunState {
	agentKey: string;
	doomCounts: Map<string, number>;
}
