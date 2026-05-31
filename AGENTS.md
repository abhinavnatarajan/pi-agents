# Pi Agent System Planning Spec

This document is a planning artifact for implementing interactive Pi agents with tool and skill permissions. It is intentionally implementation-independent until the semantics are stable.

## 1. Goals

Implement an agent system for Pi where a user can switch between named agents. Each agent defines:

- name and description
- default and fallback models
- optional thinking level
- agent prompt
- tool permissions
- skill permissions

The system should be enforceable, reloadable, and usable from interactive TUI, print, JSON, and RPC modes. We are not implementing subagents.

## 2. Non-goals for the first implementation

- No subagent orchestration.
- No background autonomous agents.
- No separate plan mode unless represented as a normal agent.
- No OS-level sandboxing in the core agent system; permission gates are advisory/enforcement at Pi tool-call level. OS sandboxing can remain a separate extension.
- No V1 hiding of disallowed skills from autocomplete. Enforcement happens at prompt filtering and invocation time.

## 3. Agent definition locations

Agent definitions are YAML files. The global Pi agent directory should be resolved through Pi's configured agent directory, i.e. `$PI_CODING_AGENT_DIR` when set, rather than hardcoding `~/.pi/agent`.

Proposed locations:

- Global: `$PI_CODING_AGENT_DIR/agents/*.yml` and `$PI_CODING_AGENT_DIR/agents/*.yaml`
- Project: `<cwd>/.pi/agents/*.yml` and `<cwd>/.pi/agents/*.yaml`

Project definitions with the same canonical agent name merge into global definitions. Project-only agents are also allowed.

Agent names are canonicalized for identity by trimming whitespace and comparing case-insensitively. Display preserves the configured `name`.

## 4. Built-in fallback agent

Pi should always have a usable `General` agent, even if no YAML files exist or all YAML files are invalid.

Initial `General` semantics:

- Allows read-only filesystem operations inside current directory.
- Denies read-only filesystem operations outside current directory.
- Asks for write/edit operations inside current directory.
- Denies write/edit operations outside current directory.
- Denies dangerous bash commands starting with known destructive/admin/shell/linking commands.
- Asks for all other bash commands.
- Allows no skills by default.

## 5. Proposed YAML schema

Example:

```yaml
name: General
description: General-purpose coding assistant with conservative permissions.
models:
  default: "*"
  fallbacks: []
  thinking: high
prompt: |
  You are the General agent. Be concise and careful.

tools:
  rules:
    - match: "*"
      permission: deny

    - match: read
      permission: allow
      when:
        path:
          field: path
          withinCwd: true

    - match: [grep, find, ls]
      permission: allow
      when:
        path:
          field: path
          withinCwd: true

    - match: [write, edit]
      permission: ask
      when:
        path:
          field: path
          withinCwd: true

    - match: bash
      permission: ask

    - match: bash
      permission: deny
      when:
        command:
          field: command
          startsWithAny:
            - rm
            - sudo
            - chmod
            - chown
            - dd
            - mkfs
            - mount
            - umount
            - kill
            - pkill
            - killall
            - shutdown
            - reboot
            - ln
            - sh
            - bash
            - zsh
            - fish
            - nushell
            - cmd
            - pwsh

skills:
  rules:
    - match: "*"
      permission: deny

doomLoop:
  threshold: 3
  permission: ask
```

### Field notes

- `name`: required.
- `description`: required for UI display.
- `models.default`: optional provider/model string. `"*"` means keep the currently selected model when switching to this agent.
- `models.fallbacks`: optional ordered provider/model list. Ignored when `models.default` is `"*"`.
- `models.thinking`: optional Pi thinking level. `"*"` means keep the current thinking level unchanged.
- `prompt`: optional agent-specific instructions appended to Pi's system prompt.
- No separate `goals` field in V1. Goals can be written directly in `prompt`; the model would see both as the same prompt content, so a separate field adds schema complexity without clear benefit.
- `tools.rules`: ordered tool permission rules. A wildcard `match: "*"` acts as the default rule.
- `skills.rules`: ordered skill permission rules. A wildcard `match: "*"` acts as the default rule.
- `doomLoop`: optional repeated-identical-call protection.

## 6. Merge semantics

When a project agent definition has the same canonical name as a global definition:

- Scalars replace global values.
- Objects deep-merge.
- Rule arrays append; project rules are evaluated after global rules.
- Other arrays, such as `models.fallbacks`, replace by default unless a later schema introduces a specific need for append behavior.

There is no explicit V1 rule-array replacement control. It adds complexity without enough benefit: a project-local `match: "*"` rule can effectively override earlier global behavior because later matching rules win.

Project definitions may loosen or tighten global permissions through later wildcard or specific rules.

## 7. Active agent semantics

- The active agent is session-local state.
- New sessions start with the configured default agent; if unspecified, `General`.
- Switching agents is done via `/agents`.
- `/agents` with no argument opens a selector when UI is available.
- `/agents <name>` switches directly if the name is known.
- `/agents` should be available in print/RPC modes. In non-interactive/no-UI contexts, direct `/agents <name>` works; no-argument `/agents` returns a plain-text list of available agents, marking the active agent.
- Agent switching may happen while the agent is not idle. The selected agent applies to the next user-submitted prompt, not to an already-running prompt.
- Switching while a prompt is in flight must not change permissions, prompt composition, doom-loop tracking, or tool behavior for that in-flight run. The only immediate effect is display status.
- The active agent name is shown via `ctx.ui.setStatus("agent", "use agent: <name>")` in V1 to make clear it affects the next prompt.
- Active agent state should be persisted in the session, so reload/resume can restore it by name.

## 8. Reload semantics

`/reload` reloads extensions. The agent system should use that lifecycle to reload YAML definitions.

On reload:

1. Load global and project agent definitions again.
2. Re-resolve the previously active agent by canonical name.
3. If it still exists and is valid, reapply its model/tool/skill/prompt semantics for subsequent prompts.
4. If it is missing or invalid, fall back to `General` and notify the user.
5. If `General` is also invalid in YAML, use the built-in fallback `General`.

Reload must not silently keep stale definitions.

## 9. Model semantics

When an agent becomes active:

1. If `models.default` is omitted, keep the current model.
2. If `models.default` is `"*"`, keep the current model and ignore `models.fallbacks`.
3. If `models.default` is an exact provider/model string and is available with credentials, select it.
4. Otherwise try `models.fallbacks` in order.
5. If none are available, keep the current model and notify the user.
6. If `models.thinking` is set to a concrete level, apply it after model selection. Pi may clamp unsupported thinking levels. If it is `"*"`, keep the current thinking level unchanged.

V1 model grammar is intentionally narrow:

- `"*"` is valid only for `models.default` and means “keep current model”.
- Exact `provider/model-id` strings are valid for `models.default` and `models.fallbacks`.
- Bare model ids, provider wildcards, model wildcards, and partial glob patterns are invalid in V1.
- `"*"` is invalid in `models.fallbacks`.

There is no separate `applyOnSwitch` parameter in V1; wildcard model selection handles the “do not switch model” case.

## 10. Tool availability vs tool permission

There are two related but distinct concerns:

1. **Availability**: which tool definitions are exposed to the LLM via Pi active tools.
2. **Permission enforcement**: whether a concrete tool call with concrete parameters is allowed.

Denied tool definitions should not be sent to the model.

The active tool set should include only tools that could be permitted by the active agent.

V1 exposure algorithm for each tool:

1. Collect all rules whose matcher applies to the tool name, including wildcard and regex rules.
2. Scan matching rules from last to first.
3. If the current rule is an unconditional `deny`, do not expose the tool.
4. If the current rule is `allow` or `ask`, conditional or unconditional, expose the tool.
5. If the current rule is a conditional `deny`, skip it and continue scanning earlier matching rules.
6. If no rule decides exposure, do not expose the tool.

This is intentionally optimistic. A series of conditional denies might cover every possible input, but V1 does not try to prove condition coverage or satisfiability. Concrete calls are always checked in `tool_call` before execution. Availability is prompt hygiene; permission enforcement is the security boundary within Pi.

## 11. Tool permission rule semantics

Each tool rule has:

- `match`: string, string array, wildcard `"*"`, or regex object.
- `permission`: `allow`, `deny`, or `ask`.
- `when`: optional parameter conditions.
- `reason`: optional human-readable explanation.

Example match forms:

```yaml
match: "*"
match: bash
match: [read, grep, find, ls]
match:
  regex: "^(read|grep|find|ls)$"
```

Rule evaluation:

1. Start with implicit deny if there are no matching rules.
2. Evaluate rules in order.
3. For every rule whose tool matcher and `when` conditions match, set the current decision to that rule's permission.
4. The last matching rule wins.
5. Apply doom-loop policy after normal permission evaluation.

This supports broad wildcard defaults followed by specific overrides, including project-local wildcard overrides of global rules.

## 12. Parameter condition semantics

Conditions should be declarative YAML, not executable code.

V1 condition types should cover common safe cases:

- path conditions:
  - `withinCwd: true`
  - `outsideCwd: true`
  - `matchesAny: [...]`
  - `notMatchesAny: [...]`
- command conditions:
  - `startsWithAny: [...]`
  - `matchesAny: [...]`
  - `notMatchesAny: [...]`
- generic JSON field conditions:
  - `equals`
  - `contains`
  - `in`
  - `matches`
  - `exists`

All conditions in a rule are ANDed.

Path checks must normalize paths safely:

- Resolve relative paths against `ctx.cwd`.
- Strip leading `@` if present, matching built-in tool behavior.
- For existing paths, prefer realpath/canonical resolution.
- For non-existing paths, use absolute normalized resolution.
- A path is inside cwd only if its relative path from cwd does not start with `..` and is not absolute.

## 13. Bash command semantics

Dangerous command detection should parse the first executable token conservatively, not merely check substring matches.

V1 can use a shell-token approximation with documented limitations. Dangerous command deny list for `General` should include at least:

- destructive/admin/process/system commands:
  - `rm`
  - `sudo`
  - `chmod`
  - `chown`
  - `dd`
  - `mkfs`
  - `mount`
  - `umount`
  - `kill`
  - `pkill`
  - `killall`
  - `shutdown`
  - `reboot`
- link creation:
  - `ln`
- shell escapes and nested shells:
  - `sh`
  - `bash`
  - `zsh`
  - `fish`
  - `nushell`
  - `cmd`
  - `pwsh`

The `ln` rule reduces the chance of linking to files outside the current directory as a way to bypass path permissions. Shell commands are denied because nested shells make command/path policy inspection much less reliable.

Commands not clearly denied are `ask` for the built-in `General` agent.

## 14. `ask` permission semantics

For a concrete tool or skill request with decision `ask`:

- If UI is available, prompt the user with enough detail to decide.
- If the user approves, allow the operation once.
- If the user rejects, block it and return a clear denial message.
- If UI is unavailable, deny by default for safety.

V1 has no permission caching. Every `ask` decision is per-call.

## 15. Deny behavior

Denied tool calls should be blocked before execution and return a reason to the model.

Denied skill invocations should be intercepted at the `input` event. The input should not continue to skill expansion. The user should receive a visible message/notification explaining that the active agent is not allowed to use that skill.

## 16. Skill permission semantics

Skill permissions must address two surfaces:

1. Skill descriptions in the system prompt.
2. `/skill:name` command expansion from user input.

System prompt handling:

- In `before_agent_start`, remove disallowed skill descriptions from the system prompt before the model sees them.
- The active agent prompt should also say that only allowed skills may be used.

Input handling:

- In `input`, detect `/skill:name` before Pi expands it.
- Evaluate skill permission by name.
- `allow`: continue.
- `ask`: prompt the user; continue only if approved.
- `deny`: handle the input and notify the user, preventing expansion.

Autocomplete/list display may still show disallowed skills in V1. Enforcement is behavioral. A V2 custom editor/autocomplete implementation can hide disallowed skills.

## 17. Skill rule semantics

Skill rules mirror tool rules, but match skill names rather than tool names.

Example:

```yaml
skills:
  rules:
    - match: "*"
      permission: deny
    - match: code-review
      permission: allow
    - match:
        regex: "^pdf-.*"
      permission: ask
```

Rule evaluation uses the same last-match-wins model as tool rules. If no rule matches, the implicit decision is deny.

## 18. MCP permission semantics

Pi docs state Pi has no built-in MCP. If MCP support is present, it is expected to appear as a normal extension/proxy tool.

The permission system should therefore treat MCP at two levels:

1. Top-level proxy tool, e.g. `mcp`.
2. Sub-target metadata extracted from the proxy input, e.g. server name and remote tool name.

V1 rule format:

```yaml
- match: mcp
  mcp:
    server: github
    tool: create_issue
  permission: ask
```

The extractor should be adapter-based because different MCP proxy tools may use different input shapes. The above format is acceptable for now.

## 19. Doom-loop protection

A doom loop is repeated identical tool calls with identical normalized input.

Proposed semantics:

- Track calls by key: `toolName + stableJson(input)`.
- `stableJson` recursively sorts object keys, preserves array order, preserves primitive values exactly, and omits `undefined` object fields.
- V1 does not perform tool-specific normalization. Tool-specific normalization does not generalize cleanly to arbitrary built-in, extension, SDK, or MCP proxy tools.
- Scope: current assistant run, reset on each new user prompt.
- If the user switches agents while a prompt is in flight, the current run keeps its existing doom-loop tracking. The selected agent, including fresh doom-loop tracking, applies only when the next user input starts a new run.
- Threshold: number of identical calls that triggers policy. If threshold is `3`, the third identical call triggers.
- Policy: `allow`, `ask`, or `deny`; default proposed for `General` is `ask` at threshold 3.

Doom-loop policy is evaluated after normal tool permission. It can only make the result stricter unless explicitly configured otherwise.

V1 scope is per-run.

## 20. Prompt composition

For each new agent turn:

1. Start with Pi's normal system prompt.
2. Remove disallowed skill descriptions.
3. Append active agent prompt.
4. Append a concise permissions summary for the model.

The permissions summary is not a security boundary; it is guidance to reduce denied calls.

## 21. User experience

- `/agents`: opens selector of available valid agents when UI is available; otherwise returns a plain-text list of agents with the active agent marked.
- `/agents <name>`: switches directly.
- Status: footer/status text shows `use agent: <name>`.
- Notifications:
  - switching agent
  - fallback model selected
  - invalid/missing agent after reload
  - denied tool/skill
  - invalid YAML diagnostics on reload/startup

For `ask` prompts, show:

- active agent
- requested tool/skill
- relevant parameters
- matched rule/reason when available

## 22. Diagnostics and invalid configuration

Invalid YAML files should not crash Pi.

- Parse errors: report path and parser error.
- Schema errors: report path and field error.
- Invalid agent: skip that agent.
- If active agent becomes invalid on reload: fall back to `General`.
- If multiple files define the same agent at the same scope: deterministic order by path; later path wins/merges after earlier path, with a warning.

## 23. Security notes

- Tool-call gates are useful but not equivalent to OS sandboxing.
- Bash commands can bypass naive path restrictions through shell features, symlinks, tools that write files, network downloads, etc.
- The `General` agent should conservatively ask for most bash commands.
- Nested shell invocations are denied by default for `General` because they weaken inspectability.
- For high-assurance isolation, combine this system with a sandbox/container extension.

## 24. V1 decisions

1. Project overrides can loosen or tighten global permissions through later rules, including `match: "*"`.
2. Rule arrays do not support explicit replacement in V1.
3. `ask` grants are not cacheable in V1.
4. Active agent is persisted per session.
5. `/agents` is available in print/RPC modes; direct switching works without UI.
6. Custom non-filesystem tools use generic JSON field matching in V1.
7. MCP rules use the `mcp` proxy-tool format with server and remote tool names.
8. Disallowed skills may still appear in autocomplete in V1; a custom editor/autocomplete can improve this in V2.
9. No-argument `/agents` in non-interactive/no-UI modes lists available agents and marks the active agent.
10. V1 model strings are only `"*"` for `models.default` or exact `provider/model-id`; fallbacks must be exact `provider/model-id`.
11. V1 active-tool exposure uses the backwards scan algorithm in section 10.
12. V1 doom-loop detection uses generic stable JSON input only, with no tool-specific normalization.
13. Agent switching during an in-flight run only updates display status immediately; permission/tool/skill/prompt/doom-loop semantics change on the next user input.

## 25. Source discovery findings

The installed Pi package exposes enough extension APIs for a V1 extension-first implementation. Key implementation seams observed in `dist/`:

### Extension loading and reload

- `core/resource-loader.js` discovers extensions from project/global/configured paths and loads them before skills/prompts/themes/context files.
- `core/agent-session.js` implements `session.reload()` by:
  1. emitting `session_shutdown` with reason `reload`,
  2. reloading settings/resources/extensions,
  3. rebuilding runtime/tool registry,
  4. emitting `session_start` with reason `reload`,
  5. emitting `resources_discover` with reason `reload`.
- Therefore agent YAML can be loaded by the agent extension during extension initialization or `session_start`; reload semantics can be implemented without core changes.

### Commands and non-idle switching

- `AgentSession.prompt()` handles extension commands before the `input` event and before skill/template expansion.
- Extension commands are executed immediately even while streaming.
- Interactive mode handles built-in slash commands first, then sends unknown slash commands to `session.prompt()`. Since `/agents` is not built-in, an extension command named `agents` will work in interactive mode.
- Print/JSON mode sends initial/messages through `session.prompt()`, so `/agents <name>` works as an extension command there too.
- RPC mode supports extension commands through the `prompt` command, and exposes them via `get_commands`.

### Skill handling

- Skills are loaded by `core/skills.js` and rendered into the system prompt with exported `formatSkillsForPrompt(skills)`.
- `AgentSession.prompt()` emits the `input` event before calling `_expandSkillCommand()` and `expandPromptTemplate()`.
- Therefore `/skill:name` permissions can be enforced in `input` by returning `handled` for denied/rejected invocations.
- The current system prompt can be filtered in `before_agent_start`. Because `formatSkillsForPrompt` is exported and `event.systemPromptOptions.skills` is supplied, V1 can replace the all-skills block with an allowed-skills block rather than doing brittle ad hoc XML parsing.
- Interactive autocomplete still builds skill command entries directly from loaded skills when skill commands are enabled. Hiding denied skills requires V2 custom autocomplete/editor or core changes.

### Tool availability and enforcement

- `pi.getAllTools()`, `pi.getActiveTools()`, and `pi.setActiveTools()` are extension APIs backed by `AgentSession`.
- `setActiveTools()` rebuilds the base system prompt and changes the actual tool list sent to the LLM on the next turn.
- Tool definitions that are not active are not included in the prompt/tool list, satisfying the “denied-only tool definitions should not be sent to the model” requirement for V1.
- Concrete enforcement is available through the `tool_call` event. Returning `{ block: true, reason }` blocks execution before the tool runs.
- Built-in tool input fields:
  - `read`: `path`, `offset?`, `limit?`
  - `write`: `path`, `content`
  - `edit`: `path`, `edits[]`
  - `grep`: `pattern`, `path?`, `glob?`, `ignoreCase?`, `literal?`, `context?`, `limit?`
  - `find`: `pattern`, `path?`, `limit?`
  - `ls`: `path?`, `limit?`
  - `bash`: `command`, `timeout?`
- Built-in tools normalize paths with helpers that strip leading `@`; the agent extension should mirror this for permission checks.

### Status/UI behavior

- `ctx.ui.setStatus()` is available in interactive and RPC modes. In print/JSON mode `ctx.hasUI` is false and UI calls are no-ops.
- V1 should call `setStatus("agent", "use agent: <name>")` when UI is available, while still allowing `/agents <name>` in no-UI modes.
- `ask` in RPC mode is possible through extension UI requests. In print/JSON mode `ctx.hasUI` is false, so `ask` should deny by default.

### Session persistence

- Extensions can persist state with `pi.appendEntry(customType, data)`.
- The session manager exposes `ctx.sessionManager.getBranch()` and `getEntries()` for restoration.
- V1 should persist active agent changes as custom entries and restore the last matching entry from the current branch on `session_start`/reload.

### Core-change candidates after V1

- Hide denied skills from built-in autocomplete and RPC `get_commands`.
- Add first-class agent resource loading if extension-managed YAML proves awkward.
- Add a native permission layer if multiple extensions need shared enforcement ordering.
- Add native active-agent UI label if footer status is insufficient.
