# Agent System Planning TODO

This TODO tracks planning and later implementation of the Pi agent system. It is intentionally phased so semantics can stabilize before source-code changes.

## Phase 0: Planning artifacts

- [x] Read `GOAL.md`.
- [x] Read relevant Pi documentation for extensions, skills, TUI, settings, models, packages, sessions, and SDK.
- [x] Clarify that tool instructions belong in tool definitions via `description`, `promptSnippet`, and `promptGuidelines`.
- [x] Clarify skill enforcement surfaces: system prompt filtering and `/skill:name` input interception.
- [x] Clarify active agent display: use `ctx.ui.setStatus()` for V1.
- [x] Clarify reload concern: re-resolve active agent by name and fall back safely.
- [x] Draft semantic spec in `AGENTS.md`.
- [x] Revise semantic spec based on user decisions: wildcard defaults, no separate goals, append-only rules, non-idle switching, wildcard model retention, expanded dangerous bash list, and no denied tool definitions in prompt.

## Phase 1: Semantic decisions

- [x] Confirm agent YAML locations:
  - global `$PI_CODING_AGENT_DIR/agents/*.yml`
  - project `<cwd>/.pi/agents/*.yml`
- [x] Confirm active agent persistence scope:
  - session-local via extension custom entry.
- [x] Confirm project override semantics:
  - deep merge objects, append permission rules, project rules evaluated after global rules.
- [x] Decide whether project definitions may loosen global permissions or only tighten them:
  - they may loosen through later rules, including `match: "*"`.
- [x] Decide whether V1 needs explicit rule-array replacement controls:
  - no.
- [x] Confirm rule precedence:
  - ordered rules, last matching rule wins.
- [x] Confirm default permission posture:
  - implicit deny unless a rule matches; `match: "*"` is the explicit default rule.
- [x] Confirm `ask` behavior:
  - per-call only, no caching in V1, deny when no UI.
- [x] Confirm doom-loop scope:
  - per assistant run, reset on new user prompt and agent switch.
- [x] Decide whether denied skills must be hidden from autocomplete in V1 or only blocked at invocation and removed from prompt:
  - blocked/removed only in V1; custom editor/autocomplete can be V2.
- [x] Decide whether `/agents` should wait for idle or refuse while the agent is running:
  - neither; agent switching may happen while non-idle and applies to the next user-submitted prompt.
- [x] Decide whether `/agents` is interactive-only:
  - no; it should be available in print/RPC modes, with direct switching and non-interactive listing/usage behavior.
- [x] Decide model no-switch behavior:
  - `models.default: "*"` means keep current model and ignore fallbacks.
- [x] Decide whether to keep a separate `goals` field:
  - no; fold goals into `prompt`.

## Phase 2: Remaining semantic details to refine

- [x] Specify exact non-interactive `/agents` no-argument output:
  - return a plain-text list of available agents and mark the active agent.
- [x] Specify exact model string grammar:
  - `models.default` supports omitted, `"*"`, or exact `provider/model-id`; `models.fallbacks` supports only exact `provider/model-id`.
- [x] Specify exact system-prompt skill block filtering strategy once the current prompt format is inspected:
  - use exported `formatSkillsForPrompt()`: replace the block generated from all loaded skills with the block generated from allowed skills.
- [x] Specify active-tool calculation precisely for parameter-dependent and MCP-specific rules:
  - scan matching rules from last to first; unconditional deny hides; any allow/ask exposes; conditional deny is skipped.
- [x] Specify stable JSON normalization for doom-loop detection:
  - generic stable JSON only; sort object keys, preserve array order/primitives, omit `undefined`; no tool-specific normalization.
- [x] Specify path condition placeholder behavior:
  - support only leading `<env:home>`, `<env:pi_coding_agent_dir>`, and `<env:pi_package_dir>` placeholders; no shell expansion.
- [x] Specify whether doom-loop reset on agent switch should affect only future calls or current in-flight tracking too:
  - agent switching affects only future user-input prompts; in-flight tool calls keep current semantics, and only display status changes immediately.

## Phase 3: Source-code discovery

No code changes in this phase.

- [x] Locate extension loading and reload lifecycle implementation:
  - `dist/core/resource-loader.js`
  - `dist/core/agent-session.js` (`reload()`, `bindExtensions()`, `extendResourcesFromExtensions()`)
- [x] Locate command registration and built-in slash command handling:
  - `dist/core/extensions/loader.js` (`registerCommand`)
  - `dist/core/extensions/runner.js` (`getCommand`, command contexts)
  - `dist/core/agent-session.js` (`_tryExecuteExtensionCommand`)
  - `dist/modes/interactive/interactive-mode.js` (built-in commands before extension commands)
  - `dist/modes/rpc/rpc-mode.js` (`prompt`, `get_commands`)
- [x] Locate skill discovery, skill prompt rendering, and `/skill:name` expansion:
  - `dist/core/skills.js`
  - `dist/core/system-prompt.js`
  - `dist/core/agent-session.js` (`_expandSkillCommand`)
- [x] Locate system prompt construction and identify reliable skill-block filtering boundaries:
  - `dist/core/system-prompt.js`
  - exported `formatSkillsForPrompt()` can generate both all-skill and allowed-skill blocks.
- [x] Locate active tool management and where `pi.setActiveTools()` updates prompt/tool state:
  - `dist/core/agent-session.js` (`setActiveToolsByName`, `_rebuildSystemPrompt`, `_refreshToolRegistry`)
- [x] Locate built-in tool schemas and input shapes for `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash`:
  - `dist/core/tools/*.d.ts`
- [x] Locate TUI footer/status rendering to validate `setStatus("agent", ...)` behavior:
  - extension UI supports `setStatus`; interactive and RPC have UI contexts, print/JSON use no-op UI.
- [x] Locate session custom entry APIs and examples for persisting active agent state:
  - `pi.appendEntry()` binds to `sessionManager.appendCustomEntry()`; restore via `ctx.sessionManager.getBranch()`.
- [ ] Locate tests or test harnesses for extensions, tools, commands, and settings.

## Phase 4: Extension-first prototype

Source discovery indicates V1 is feasible as an extension-first implementation before core changes.

- [x] Create an agent-system extension entrypoint.
- [x] Load global and project YAML agent definitions.
- [x] Validate agent definitions and collect diagnostics.
- [x] Add built-in fallback `General` agent.
- [x] Implement merge semantics.
- [x] Implement active agent state and restoration.
- [x] Register `/agents` command for interactive, print, JSON, and RPC modes.
- [x] Implement agent selector UI for UI-capable modes.
- [x] Implement direct `/agents <name>` switching.
- [x] Implement non-interactive `/agents` no-argument behavior.
- [x] Show active agent with `ctx.ui.setStatus("agent", "use agent: <name>")`.
- [x] Apply selected agent to subsequent prompts even if switched while current agent run is active.
- [x] Apply agent model and thinking level on switch, respecting `models.default: "*"` and `models.thinking: "*"`.
- [x] Compute active tools from permission rules and call `pi.setActiveTools()` so denied-only tool definitions are not sent to the model.
- [x] Inject agent prompt/permission summary in `before_agent_start`.
- [x] Filter disallowed skill descriptions from system prompt in `before_agent_start`.
- [x] Intercept `/skill:name` in `input` and enforce skill permissions before expansion.
- [x] Enforce tool permissions in `tool_call`.
- [x] Implement `ask` prompts for tools and skills.
- [x] Implement no-UI behavior for `ask` as deny.
- [x] Implement path normalization and cwd containment checks.
- [x] Implement bash dangerous-command checks for `General`, including `ln` and nested shells.
- [x] Implement generic JSON field matching.
- [x] Implement MCP proxy-tool rule matching for server and remote tool names.
- [x] Implement doom-loop detection.
- [x] Re-resolve active agent and reapply on `/reload`.
- [x] Notify users about invalid YAML, skipped agents, and reload fallback.

## Phase 5: Evaluate prototype gaps

- [ ] Determine whether prompt skill filtering is robust enough without core changes.
- [ ] Determine whether disallowed skill commands appearing in autocomplete is acceptable for V1.
- [ ] Determine whether active tool calculation works for regex-matched tools loaded after startup.
- [ ] Determine whether extension reload reliably reapplies active agent semantics.
- [ ] Determine whether MCP proxy support needs adapter hooks beyond the V1 `mcp.server/tool` format.
- [ ] Determine whether bash/path permission enforcement requires built-in tool overrides or OS sandbox integration.

## Phase 6: Core integration candidates

Only pursue these after the extension prototype exposes concrete limitations.

- [ ] Add first-class agent definition loading to Pi resource loading.
- [ ] Add first-class active agent state to session/runtime.
- [ ] Add skill filtering before system prompt construction rather than post-processing the prompt string.
- [ ] Hide disallowed skills from command listing/autocomplete.
- [ ] Add a formal permission evaluation layer before tool execution.
- [ ] Add typed parameter-condition helpers for built-in tools.
- [ ] Add native active-agent label support near the editor if status footer is insufficient.
- [ ] Add built-in `/agents` command if extension command is insufficient.
- [ ] Add tests for reload semantics in the core runtime.

## Phase 7: Tests

- [ ] Unit test YAML parsing and validation.
- [ ] Unit test global/project merge behavior.
- [ ] Unit test wildcard default rules.
- [ ] Unit test rule matching: exact, array, wildcard, regex.
- [ ] Unit test last-match-wins precedence.
- [ ] Unit test project wildcard rule loosening/tightening.
- [ ] Unit test path normalization and cwd containment.
- [ ] Unit test bash dangerous-command matching, including `ln` and nested shells.
- [ ] Unit test generic JSON field conditions.
- [ ] Unit test MCP server/tool matching.
- [ ] Unit test tool active-set calculation excludes denied-only tools.
- [ ] Unit test `allow`, `deny`, and `ask` decisions.
- [ ] Unit test no-UI `ask` denial.
- [ ] Unit test skill `/skill:name` interception.
- [ ] Unit test system prompt skill filtering.
- [ ] Unit test doom-loop threshold behavior.
- [ ] Integration test `/agents` switching while idle.
- [ ] Integration test `/agents` switching while an agent run is active, applying to the next prompt.
- [ ] Integration test `/agents <name>` in non-interactive/RPC mode.
- [ ] Integration test reload with active agent unchanged.
- [ ] Integration test reload with active agent deleted/invalid and fallback to `General`.
- [ ] Integration test model fallback selection.
- [ ] Integration test `models.default: "*"` keeps current model and ignores fallbacks.
- [ ] Integration test session restore of active agent.

## Phase 8: Documentation and examples

- [x] Document agent YAML schema.
- [x] Document wildcard default rules.
- [x] Document merge semantics.
- [x] Document permission rule semantics.
- [x] Document default `General` agent.
- [x] Document `ask` behavior and limitations.
- [x] Document security limitations and sandbox recommendation.
- [ ] Provide example `General` agent YAML.
- [ ] Provide example `Planner` read-only agent YAML.
- [ ] Provide example `Reviewer` agent with selected skills.
- [ ] Provide example project override using `match: "*"`.
- [ ] Provide troubleshooting section for invalid YAML and missing models.

## Current open details

No known semantic blockers remain for a V1 extension-first prototype.
