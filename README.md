# Pi Agent System Extension

This repository implements a V1, extension-first agent system for [Pi](https://github.com/earendil-works/pi-mono). It lets users switch between named interactive agents, where each agent defines model preferences, prompt guidance, tool permissions, skill permissions, and doom-loop protection.

The extension is intended to feel similar to OpenCode-style agents while staying inside Pi's extension APIs. It does **not** implement subagents or OS-level sandboxing.

## Scope and goals

The agent system provides:

- YAML-defined agents.
- A built-in fallback `General` agent.
- `/agents` command for listing and switching agents.
- Active agent status in the Pi UI footer.
- Tool exposure control with `pi.setActiveTools()`.
- Concrete tool-call enforcement in the `tool_call` event.
- Skill prompt filtering and `/skill:name` invocation enforcement.
- Model and thinking-level selection on agent switch.
- Session-local active-agent persistence.
- Hot reload through Pi's normal `/reload` lifecycle.

Non-goals for V1:

- No subagent orchestration.
- No autonomous background agents.
- No OS/container sandboxing.
- No hiding denied skills from built-in autocomplete.
- No proof that conditional permission rules cover every possible input.

For security-sensitive workflows, combine this with a real sandbox/container extension. Tool-call gates are useful, but they are not equivalent to process isolation.

## Installation and development

Pi auto-discovers extensions from `$PI_CODING_AGENT_DIR/extensions`. During development, symlink this directory there:

```bash
ln -s /path/to/this/repo "$PI_CODING_AGENT_DIR/extensions/agent-system"
```

If the YAML parser is not available through Pi's dependency tree, install local dependencies once:

```bash
npm install
```

Quick smoke test without symlinking:

```bash
pi -e ./index.ts -p '/agents'
```

## Agent definition locations

Agent definitions are YAML files loaded from:

- Global: `$PI_CODING_AGENT_DIR/agents/*.yml` and `$PI_CODING_AGENT_DIR/agents/*.yaml`
- Project: `<cwd>/.pi/agents/*.yml` and `<cwd>/.pi/agents/*.yaml`

Project definitions merge with global definitions that have the same canonical agent name. Canonical names are trimmed and compared case-insensitively. Display names preserve the configured `name`.

Pi's configured agent directory is resolved through Pi's own `getAgentDir()` helper, so `PI_CODING_AGENT_DIR` is respected.

## Basic usage

List agents:

```text
/agents
```

Switch directly:

```text
/agents Planner
```

Interactive mode opens a selector when `/agents` has no argument. Print/JSON/RPC/no-UI mode returns a plain-text list with the active agent marked.

Switching while an agent run is in flight only changes the visible status immediately. Tool permissions, prompt composition, skill permissions, and doom-loop tracking for the in-flight run continue unchanged. The newly selected agent applies to the next user-submitted prompt.

## YAML schema

Example:

```yaml
name: Planner
description: Read-only planning agent.
models:
  default: "*"
  fallbacks: []
  thinking: high
prompt: |
  You are in planning mode. Read and analyze, but do not edit files.

tools:
  rules:
    - match: "*"
      permission: deny

    - match: [read, grep, find, ls]
      permission: allow
      when:
        path:
          field: path
          withinCwd: true

    - match: bash
      permission: ask

skills:
  rules:
    - match: "*"
      permission: deny
    - match: code-review
      permission: allow

doomLoop:
  threshold: 3
  permission: ask
```

Top-level fields:

- `name` — required display name.
- `description` — required UI/list description.
- `models.default` — optional exact `provider/model-id`, or `"*"` to keep the current model.
- `models.fallbacks` — optional exact `provider/model-id` list. `"*"` is invalid here.
- `models.thinking` — optional Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `prompt` — optional agent instructions appended to Pi's system prompt.
- `tools.rules` — ordered tool permission rules.
- `skills.rules` — ordered skill permission rules.
- `doomLoop` — optional repeated-identical-tool-call protection.

## Merge semantics

When project and global definitions share the same canonical agent name:

- Scalars replace earlier values.
- Objects deep-merge.
- `tools.rules` and `skills.rules` append.
- Other arrays, such as `models.fallbacks`, replace.

Rules are evaluated in order, and the last matching rule wins. Because project rules are appended after global rules, project agents can tighten or loosen global defaults.

## Permission rules

Rules have this shape:

```yaml
- match: read
  permission: allow
  when:
    path:
      field: path
      withinCwd: true
  reason: Optional human-readable reason
```

`match` forms:

```yaml
match: "*"
match: bash
match: [read, grep, find, ls]
match:
  regex: "^(read|grep|find|ls)$"
```

Permissions:

- `allow` — execute without prompting.
- `ask` — ask the user once for this invocation; deny in no-UI modes.
- `deny` — block the tool or skill.

Condition types supported in V1:

- Path conditions: `withinCwd`, `outsideCwd`, `matchesAny`, `notMatchesAny`
- Command conditions: `startsWithAny`, `matchesAny`, `notMatchesAny`
- Generic JSON-field conditions: `equals`, `contains`, `in`, `matches`, `exists`

All conditions in a rule are ANDed.

Path checks strip a leading `@`, resolve relative paths against `ctx.cwd`, normalize the result, and then check containment in the current working directory.

## Tool exposure vs enforcement

There are two layers:

1. **Exposure** controls which tool definitions are sent to the model via `pi.setActiveTools()`.
2. **Enforcement** checks concrete tool calls in `tool_call` immediately before execution.

Exposure is intentionally optimistic. For each tool, the extension scans matching rules from last to first:

1. Unconditional `deny` hides the tool.
2. Conditional or unconditional `allow`/`ask` exposes the tool.
3. Conditional `deny` is skipped and scanning continues.
4. No deciding rule hides the tool.

Concrete enforcement always evaluates all applicable conditions with actual tool input. That is the security boundary inside Pi.

## Skills

Skill permissions affect two surfaces:

- The skill descriptions included in the system prompt.
- Explicit `/skill:name` invocations.

The extension filters the skill prompt block in `before_agent_start` using Pi's exported `formatSkillsForPrompt()` helper. It also intercepts `/skill:name` in the `input` event before Pi expands the skill.

Denied skills may still appear in Pi's built-in autocomplete in V1, but invocation is blocked.

## Built-in `General` agent

`General` is always available even when no YAML files exist or YAML files are invalid.

Its default posture:

- Allows `read`, `grep`, `find`, and `ls` inside the current working directory.
- Denies those read-only operations outside the current working directory.
- Asks for `write` and `edit` inside the current working directory.
- Denies `write` and `edit` outside the current working directory.
- Asks for most `bash` commands.
- Denies dangerous first executable tokens such as `rm`, `sudo`, `chmod`, `chown`, `dd`, `mkfs`, `mount`, `umount`, `kill`, `pkill`, `killall`, `shutdown`, `reboot`, `ln`, and nested shells.
- Denies all skills by default.

## Doom-loop protection

A doom loop is repeated identical tool calls with identical input.

The key is:

```text
toolName + "\0" + stableJson(input)
```

`stableJson` recursively sorts object keys, preserves array order, preserves primitive values exactly, and omits `undefined` object fields. V1 deliberately performs no tool-specific normalization.

If `threshold: 3`, the third identical call triggers the configured doom-loop permission. Doom-loop policy can only make the normal permission stricter.

## MCP proxy rules

Pi does not have built-in MCP support. If an MCP proxy extension exposes a normal Pi tool, this extension treats it as a normal tool with optional sub-target metadata:

```yaml
- match: mcp
  mcp:
    server: github
    tool: create_issue
  permission: ask
```

The V1 extractor looks for common fields such as `server`, `serverName`, `mcpServer`, `tool`, `toolName`, and `mcpTool` in the proxy tool input.

## Architecture

Entrypoint:

- `index.ts` wires the extension into Pi events and commands.

Modules:

- `src/types.ts` — shared schema and runtime types.
- `src/default-agent.ts` — built-in `General` agent definition.
- `src/config-loader.ts` — YAML discovery, parsing, validation, and merge semantics.
- `src/permissions.ts` — rule matching, condition evaluation, tool exposure, `ask`, and doom-loop logic.
- `src/prompt.ts` — permissions summary and skill prompt filtering.
- `src/session-state.ts` — active-agent persistence helpers and command formatting.
- `src/utils.ts` — shared small utilities, YAML loading, and no-UI output handling.

Pi integration points:

- `session_start` loads YAML, restores active agent, applies tools/model/thinking, and updates status.
- `/agents` lists or switches agents.
- `input` starts per-run state and blocks denied `/skill:name` invocations.
- `before_agent_start` filters skills and appends agent prompt/permission summary.
- `tool_call` enforces tool permissions and doom-loop policy.
- `agent_end` clears per-run doom-loop state.

## Testing checklist

Useful manual checks:

```bash
pi -e ./index.ts -p '/agents'
PI_CODING_AGENT_DIR=/tmp/pi-agent-test pi -e ./index.ts -p '/agents'
```

Interactive checks:

1. `/agents` opens a selector.
2. `/agents <name>` switches directly.
3. The footer status changes to `use agent: <name>`.
4. `ask` rules show confirmation dialogs.
5. Denied tools are blocked before execution.
6. Denied `/skill:name` inputs do not expand.
7. `/reload` reloads edited YAML and falls back safely if the active agent becomes invalid.
