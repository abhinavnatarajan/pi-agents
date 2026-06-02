import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export function canonicalizeAgentName(name: string): string {
	return name.trim().toLowerCase();
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getNestedFieldValue(input: Record<string, unknown>, field: string): unknown {
	const parts = field.split(".");
	let current: unknown = input;
	for (const part of parts) {
		if (!isPlainObject(current) || !(part in current)) {
			return undefined;
		}
		current = current[part];
	}
	return current;
}

export function jsonDeepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => jsonDeepEqual(value, b[index]));
	}
	if (isPlainObject(a) || isPlainObject(b)) {
		if (!isPlainObject(a) || !isPlainObject(b)) return false;
		const aEntries = Object.entries(a).filter(([, value]) => value !== undefined);
		const bEntries = Object.entries(b).filter(([, value]) => value !== undefined);
		if (aEntries.length !== bEntries.length) return false;
		return aEntries.every(([key, value]) => Object.prototype.hasOwnProperty.call(b, key) && jsonDeepEqual(value, b[key]));
	}
	return false;
}

export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export async function loadYamlLibrary(): Promise<{ parse: (text: string) => unknown }> {
	try {
		return (await import("yaml")) as { parse: (text: string) => unknown };
	} catch { }

	const require = createRequire(import.meta.url);
	try {
		return require("yaml") as { parse: (text: string) => unknown };
	} catch { }

	const homePiYaml = process.env.HOME
		? join(process.env.HOME, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "yaml")
		: undefined;
	if (homePiYaml) {
		try {
			return require(homePiYaml) as { parse: (text: string) => unknown };
		} catch { }
	}

	throw new Error("Unable to load YAML parser. Run `npm install` in the agent-system extension directory to install the `yaml` dependency.");
}

export function emitNoUiText(customMessageSender: (text: string) => void, text: string): void {
	if (isLikelyJsonMode()) {
		customMessageSender(text);
		return;
	}
	process.stdout.write(`${text}\n`);
}

function isLikelyJsonMode(): boolean {
	const modeIndex = process.argv.indexOf("--mode");
	return modeIndex >= 0 && process.argv[modeIndex + 1] === "json";
}

export function packageRelativeDir(metaUrl: string): string {
	return dirname(new URL(metaUrl).pathname);
}

let cachedPiPackageDir: string | undefined
export function getPiPackageDir(): string {
	if (cachedPiPackageDir) return cachedPiPackageDir;
	try {
		const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
		const resolvedPath = fileURLToPath(resolved);
		cachedPiPackageDir = resolvedPath.endsWith("/dist/index.js") ? dirname(dirname(resolvedPath)) : dirname(resolvedPath);
		return cachedPiPackageDir;
	} catch {
		throw new Error("Unable to resolve <env:pi_package_dir> for path permission rule.");
	}
}

