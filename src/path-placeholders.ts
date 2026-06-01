import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConditionSpec, Rule } from "./types.ts";

const placeholderNames = ["cwd", "home", "pi_coding_agent_dir", "pi_package_dir"] as const;
type PlaceholderName = (typeof placeholderNames)[number];

const placeholderPrefix = "<env:";

export function expandPathPattern(pattern: string, ctx: ExtensionContext): string {
	return expandLeadingPathPlaceholder(pattern, ctx, "regex");
}

export function expandPathLiteral(value: string, ctx: ExtensionContext): string {
	return expandLeadingPathPlaceholder(value, ctx, "literal");
}

export function validatePathRulePlaceholders(rule: Rule): string[] {
	const errors: string[] = [];
	for (const [conditionName, condition] of Object.entries(rule.when ?? {})) {
		if (!condition || typeof condition !== "object" || Array.isArray(condition)) continue;
		const spec = condition as ConditionSpec;
		const field = typeof spec.field === "string" ? spec.field : conditionName;
		if (!isPathField(field)) continue;

		for (const value of collectStringValues(spec)) {
			const error = validatePlaceholderString(value);
			if (error) errors.push(error);
		}
	}
	return errors;
}

export function isPathField(field: string): boolean {
	return field === "path" || field.endsWith(".path");
}

function collectStringValues(spec: ConditionSpec): string[] {
	const values: string[] = [];
	if (typeof spec.matches === "string") values.push(spec.matches);
	if (typeof spec.equals === "string") values.push(spec.equals);
	if (typeof spec.contains === "string") values.push(spec.contains);
	if (Array.isArray(spec.matchesAny)) values.push(...spec.matchesAny.filter((v): v is string => typeof v === "string"));
	if (Array.isArray(spec.notMatchesAny)) values.push(...spec.notMatchesAny.filter((v): v is string => typeof v === "string"));
	if (Array.isArray(spec.in)) values.push(...spec.in.filter((v): v is string => typeof v === "string"));
	return values;
}

function validatePlaceholderString(value: string): string | undefined {
	if (!value.startsWith(placeholderPrefix)) return undefined;
	const parsed = parseLeadingPlaceholder(value);
	if (!parsed) {
		return `Invalid path placeholder in "${value}". Escape a literal leading placeholder as \\<env:...>, or use one of ${placeholderNames.map((n) => `<env:${n}>`).join(", ")}.`;
	}
	return undefined;
}

function expandLeadingPathPlaceholder(input: string, ctx: ExtensionContext, mode: "literal" | "regex"): string {
	if (input.startsWith(`\\${placeholderPrefix}`)) return input.slice(1);
	const parsed = parseLeadingPlaceholder(input);
	if (!parsed) return input;

	const replacement = placeholderValue(parsed.name, ctx);
	const normalized = toPosixPath(replacement);
	const safeReplacement = mode === "regex" ? escapeRegExp(normalized) : normalized;
	return `${safeReplacement}${parsed.rest}`;
}

function parseLeadingPlaceholder(input: string): { name: PlaceholderName; rest: string } | undefined {
	if (!input.startsWith(placeholderPrefix)) return undefined;
	const end = input.indexOf(">", placeholderPrefix.length);
	if (end === -1) return undefined;

	const rawName = input.slice(placeholderPrefix.length, end);
	if (!isPlaceholderName(rawName)) return undefined;

	const rest = input.slice(end + 1);
	if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("\\")) return undefined;
	return { name: rawName, rest: rest.replace(/\\/g, "/") };
}

function isPlaceholderName(value: string): value is PlaceholderName {
	return (placeholderNames as readonly string[]).includes(value);
}

function placeholderValue(name: PlaceholderName, ctx: ExtensionContext): string {
	switch (name) {
		case "cwd":
			return ctx.cwd;
		case "home":
			return homedir();
		case "pi_coding_agent_dir":
			return getAgentDir();
		case "pi_package_dir":
			return getPiPackageDir(ctx);
	}
}

let cachedPiPackageDir: string | undefined;

function getPiPackageDir(ctx: ExtensionContext): string {
	if (cachedPiPackageDir) return cachedPiPackageDir;

	try {
		const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
		const resolvedPath = fileURLToPath(resolved);
		cachedPiPackageDir = resolvedPath.endsWith("/dist/index.js") ? dirname(dirname(resolvedPath)) : dirname(resolvedPath);
		return cachedPiPackageDir;
	} catch {}

	// Fallback for unusual loaders: use the docs path embedded in Pi's system prompt.
	const match = ctx.getSystemPrompt?.().match(/Main documentation: (.*\/README\.md)/);
	if (match?.[1]) {
		cachedPiPackageDir = dirname(match[1]);
		return cachedPiPackageDir;
	}

	throw new Error("Unable to resolve <env:pi_package_dir> for path permission rule.");
}

function toPosixPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
