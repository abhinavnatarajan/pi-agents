import type { Model } from "@earendil-works/pi-ai";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { loadAgentConfig } from "./src/config-loader.ts";
import { loadAgentActionKeybindings } from "./src/keybinding-actions.ts";
import { builtInGeneralAgent } from "./src/default-agent.ts";
import { applyDoomLoop, askPermission, evalToolPermissions, shouldExposeTool, evalSkillPermissions } from "./src/evaluate-permissions.ts";
import { filterSkillPromptBlock } from "./src/prompt.ts";
import { findRestoredAgentKey, formatAgentList, skillNameFromInput } from "./src/session-state.ts";
import { EXTENSION_STATE_TYPE, STATUS_KEY, type LoadedAgent, type LoadedConfig, type RunState } from "./src/types.ts";
import { canonicalizeAgentName, emitNoUiText } from "./src/utils.ts";

export default function agentSystemExtension(pi: ExtensionAPI) {
	let config: LoadedConfig = { agents: new Map([["general", builtInGeneralAgent()]]), diagnostics: [] };
	let selectedAgentKey = "general";
	let runtimeAppliedAgentKey: string | undefined;
	let runState: RunState | undefined;

	function getSelectedAgent(): LoadedAgent {
		return config.agents.get(selectedAgentKey) ?? config.agents.get("general") ?? builtInGeneralAgent();
	}

	function getRunAgent(): LoadedAgent {
		return config.agents.get(runState?.agentKey ?? selectedAgentKey) ?? getSelectedAgent();
	}

	function updateStatus(ctx: ExtensionContext): void {
		const agent = getSelectedAgent();
		ctx.ui.setStatus(STATUS_KEY, `Agent: ${agent.name}`);
	}

	async function notifyDiagnostics(ctx: ExtensionContext): Promise<void> {
		for (const diagnostic of config.diagnostics) {
			const message = `${diagnostic.path ? `${diagnostic.path}: ` : ""}${diagnostic.message}`;
			ctx.ui.notify(message, diagnostic.type === "error" ? "error" : "warning");
		}
	}

	async function applyAgentRuntime(agent: LoadedAgent, ctx: ExtensionContext): Promise<void> {
		const activeTools = pi
			.getAllTools()
			.filter((tool) => shouldExposeTool(agent, tool.name))
			.map((tool) => tool.name);
		pi.setActiveTools(activeTools);

		const selected = await selectConfiguredModel(agent, ctx);
		if (!selected) {
			ctx.ui.notify(`Agent "${agent.name}": no configured model/fallback is available; keeping current model.`, "warning");
		}
		runtimeAppliedAgentKey = agent.canonicalName;
	}

	async function selectConfiguredModel(agent: LoadedAgent, ctx: ExtensionContext): Promise<boolean> {
		if (agent.models == undefined) return true;
		const candidates = [agent.models.default, ...(agent.models.fallbacks ?? [])];
		for (const spec of candidates) {
			const model = ctx.modelRegistry.find(spec.provider, spec.modelId) as Model<any> | undefined;
			if (!model) continue;
			const ok = await pi.setModel(model);
			if (spec.thinking != null) pi.setThinkingLevel(spec.thinking);
			if (ok) {
				if (spec.provider !== agent.models.default.provider) {
					ctx.ui.notify(`Agent "${agent.name}": selected fallback provider ${spec.provider}.`, "warning");
				}
				if (spec.modelId !== agent.models.default.modelId) {
					ctx.ui.notify(`Agent "${agent.name}": selected fallback model ${spec}.`, "warning");
				}
				return true;
			}
		}
		return false;
	}

	async function prepareNextRun(ctx: ExtensionContext): Promise<void> {
		const agent = getSelectedAgent();
		if (runtimeAppliedAgentKey !== agent.canonicalName) {
			await applyAgentRuntime(agent, ctx);
		}
		runState = { agentKey: agent.canonicalName, doomCounts: new Map() };
	}

	async function switchAgent(key: string, ctx: ExtensionContext): Promise<string> {
		const agent = config.agents.get(key);
		if (!agent) {
			const available = [...config.agents.values()].map((a) => a.name).sort().join(", ");
			const message = `Unknown agent "${key}". Available agents: ${available}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			return message;
		}

		return await activateAgent(agent, ctx);
	}

	async function activateAgent(agent: LoadedAgent, ctx: ExtensionContext): Promise<string> {
		selectedAgentKey = agent.canonicalName;
		pi.appendEntry(EXTENSION_STATE_TYPE, { name: agent.name });
		updateStatus(ctx);
		if (ctx.isIdle()) {
			await applyAgentRuntime(agent, ctx);
		}
		const message = `Using agent: ${agent.name}`;
		if (ctx.hasUI) ctx.ui.notify(message, "info");
		return message;
	}

	async function cycleAgent(direction: 1 | -1, ctx: ExtensionContext): Promise<void> {
		const agents = getAgentOrder();
		if (agents.length === 0) return;
		const currentIndex = agents.findIndex((agent) => agent.canonicalName === selectedAgentKey);
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + agents.length) % agents.length;
		await activateAgent(agents[nextIndex]!, ctx);
	}

	function getAgentOrder(): LoadedAgent[] {
		return [...config.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	async function showAgentSelector(ctx: ExtensionContext): Promise<void> {
		const agents = getAgentOrder();
		if (agents.length === 0) return;
		const options = agents.map((agent) => `${agent.name} - ${agent.description}`);
		const choice = await ctx.ui.select("Select agent", options);
		if (!choice) return;
		const name = choice.split(" - ")[0]!;
		await switchAgent(canonicalizeAgentName(name), ctx);
	}

	for (const binding of loadAgentActionKeybindings()) {
		pi.registerShortcut(binding.key, {
			description: binding.description,
			handler: async (ctx) => {
				if (binding.action === "app.agent.select") await showAgentSelector(ctx);
				else if (binding.action === "app.agent.cycleForward") await cycleAgent(1, ctx);
				else await cycleAgent(-1, ctx);
			},
		});
	}

	pi.registerCommand("agents", {
		description: "List or switch Pi agents",
		getArgumentCompletions: (prefix) =>
			[...config.agents.values()]
				.filter((agent) => agent.name.toLowerCase().startsWith(prefix.toLowerCase()))
				.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description })),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed) {
				const message = await switchAgent(canonicalizeAgentName(trimmed), ctx);
				if (!ctx.hasUI) emitNoUiText((text) => emitCustomMessage(pi, text), message);
				return;
			}

			if (!ctx.hasUI) {
				emitNoUiText((text) => emitCustomMessage(pi, text), formatAgentList(config.agents, selectedAgentKey));
				return;
			}

			await showAgentSelector(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await loadAgentConfig(ctx.cwd);
		const restored = findRestoredAgentKey(ctx, config.agents);
		if (restored) {
			selectedAgentKey = restored;
		} else if (!config.agents.has(selectedAgentKey)) {
			selectedAgentKey = "general";
			ctx.ui.notify("Previously active agent is missing or invalid after reload; falling back to General.", "warning");
		}
		updateStatus(ctx);
		await applyAgentRuntime(getSelectedAgent(), ctx);
		await notifyDiagnostics(ctx);
	});

	pi.on("input", async (event: InputEvent, ctx) => {
		if (!event.streamingBehavior && ctx.isIdle()) {
			await prepareNextRun(ctx);
		}

		const skillName = skillNameFromInput(event.text);
		if (!skillName) return { action: "continue" as const };

		const agent = getRunAgent();
		const decision = evalSkillPermissions(agent.skillPermissions, skillName);
		if (decision.permission === "allow") return { action: "continue" as const };
		if (decision.permission === "deny") {
			ctx.ui.notify(`Skill "${skillName}" blocked due to permission policy for agent "${agent.name}".`, "warning");
			return { action: "handled" as const };
		}

		const ok = await askPermission(ctx, agent, "skill", skillName, { skill: skillName });
		if (ok) return { action: "continue" as const };
		return { action: "handled" as const };
	});

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		if (!runState || runState.agentKey !== selectedAgentKey) {
			await prepareNextRun(ctx);
		}

		const agent = getRunAgent();
		let systemPrompt = filterSkillPromptBlock(event.systemPrompt, event.systemPromptOptions.skills, agent);
		const additions = [agent.prompt?.trim()].filter((s): s is string => !!s);
		if (additions.length > 0) systemPrompt += `\n\n${additions.join("\n\n")}`;
		return { systemPrompt };
	});

	pi.on("agent_end", async () => {
		runState = undefined;
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		const agent = getRunAgent();
		if (!runState) runState = { agentKey: agent.canonicalName, doomCounts: new Map() };

		const input = event.input as Record<string, unknown>;
		const decision = applyDoomLoop(
			agent,
			runState,
			event.toolName,
			input,
			evalToolPermissions(agent.toolPermissions, event.toolName, input, ctx),
		);

		if (decision.permission === "allow") return undefined;
		if (decision.permission === "deny") {
			let msg = `Tool "${event.toolName}" blocked due to permission policy for agent "${agent.name}".`;
			if (decision.reason) msg = msg + `\nReason: ${decision.reason}`;
			ctx.ui.notify(msg, "warning");
			return { block: true, reason: msg };
		}

		const ok = await askPermission(ctx, agent, "tool", event.toolName, input);
		if (!ok) return { block: true, reason: `User blocked tool "${event.toolName}".` };
		return undefined;
	});
}

function emitCustomMessage(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: EXTENSION_STATE_TYPE, content: text, display: true });
}
