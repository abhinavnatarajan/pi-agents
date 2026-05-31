import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export function canonicalizeAgentName(name: string): string {
	return name.trim().toLowerCase();
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	} catch {}

	const require = createRequire(import.meta.url);
	try {
		return require("yaml") as { parse: (text: string) => unknown };
	} catch {}

	const homePiYaml = process.env.HOME
		? join(process.env.HOME, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "yaml")
		: undefined;
	if (homePiYaml) {
		try {
			return require(homePiYaml) as { parse: (text: string) => unknown };
		} catch {}
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
