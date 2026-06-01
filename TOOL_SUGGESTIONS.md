# Tool Suggestions for Smoother Pi Agent Workflows

This document sketches small, focused tools/extensions that would reduce friction when working with Pi agents while avoiding broad `bash` access. These are not detailed specs; they are candidate ideas with use cases and example inputs/outputs.

## 1. Git safe-ops tool

A structured Git tool would handle common repository operations without asking for every `bash -c 'git ...'` command. Read-only operations such as `status`, `diff`, `log`, and `show` could usually be allowed. Mutating but common operations such as `add` and `commit` could be ask-gated or allowed only for explicit user requests.

Example input:

```json
{
  "action": "status",
  "short": true
}
```

Example output:

```text
 M README.md
 M src/permissions.ts
?? TOOL_SUGGESTIONS.md
```

Example input:

```json
{
  "action": "commit",
  "message": "Add path placeholder support",
  "paths": ["src/path-placeholders.ts", "src/permissions.ts", "README.md"]
}
```

Example output:

```text
Committed 3 files.
commit: 64a42ed Add path placeholder support
```

## 2. Approved command aliases tool

A generic approved-command tool could run only commands configured by the user or project. This keeps flexibility while avoiding shell interpretation and arbitrary command execution. It is useful for recurring commands such as type checks, test suites, documentation builds, and safe Git aliases.

Example config idea:

```yaml
commands:
  typecheck:
    argv: ["npm", "run", "check"]
  unit-tests:
    argv: ["npm", "test"]
  git-status:
    argv: ["git", "status", "--short"]
```

Example input:

```json
{
  "name": "typecheck"
}
```

Example output:

```text
> npm run check

Type check passed.
```

## 3. Project checks tool

A project checks tool would detect and run common validation tasks without requiring the model to know exact package-manager commands. It could inspect `package.json`, `pyproject.toml`, `Cargo.toml`, `Makefile`, etc., and expose actions such as `test`, `lint`, `typecheck`, and `format_check`.

Example input:

```json
{
  "check": "typecheck"
}
```

Example output:

```text
Detected package.json script: npm run check
Exit code: 0
Summary: Type check passed.
```

Example input:

```json
{
  "check": "test",
  "filter": "permissions"
}
```

Example output:

```text
Detected test runner: npm test -- permissions
12 tests passed, 0 failed.
```

## 4. Package/script runner tool

A package/script runner is a slightly lower-level version of the project checks tool. It would list available scripts and run a selected script with structured arguments. It should avoid install, publish, update, and arbitrary shell commands unless explicitly approved.

Example input:

```json
{
  "action": "list_scripts"
}
```

Example output:

```json
{
  "scripts": {
    "test": "vitest",
    "check": "tsc --noEmit",
    "lint": "eslint ."
  }
}
```

Example input:

```json
{
  "action": "run_script",
  "script": "test"
}
```

Example output:

```text
> npm run test

All tests passed.
```

## 5. Pi docs lookup tool

A Pi docs tool would provide a narrow interface for reading and searching the installed Pi README, docs, and examples. This avoids needing broad filesystem permission for the installed package directory and makes Pi-specific development faster.

Example input:

```json
{
  "action": "list_docs"
}
```

Example output:

```json
{
  "docs": ["extensions.md", "skills.md", "tui.md", "keybindings.md", "session-format.md"]
}
```

Example input:

```json
{
  "action": "search",
  "query": "registerShortcut"
}
```

Example output:

```text
docs/extensions.md: registerShortcut(shortcut, options)
docs/keybindings.md: keybindings.json action ids
examples/extensions/preset.ts: pi.registerShortcut(...)
```

## 6. Agent debug / permission simulator tool

An agent-debug tool would help inspect effective merged agent definitions and simulate permission decisions. This would be especially useful while editing YAML rules because it could explain which rule matched and why a tool was exposed, allowed, asked, or denied.

Example input:

```json
{
  "action": "explain_agent",
  "agent": "General"
}
```

Example output:

```text
Agent: General
Sources:
- <built-in>
- $PI_CODING_AGENT_DIR/agents/general.yml

Exposed tools: read, grep, find, ls, write, edit, bash, ask_user_question
Skills: allow *
Model: openai-codex/gpt-5.5
Thinking: high
```

Example input:

```json
{
  "action": "simulate_tool",
  "agent": "General",
  "tool": "bash",
  "input": { "command": "bash -c 'echo hi'" }
}
```

Example output:

```json
{
  "decision": "deny",
  "matchedRule": "tools.rules[8]",
  "reason": "first executable token 'bash' is in startsWithAny denylist"
}
```

## 7. File tree/navigation tool

A read-only project navigation tool could summarize repository structure and common file sets without repeated `find`, `ls`, and `grep` calls. It could list changed files, files by extension, recently modified files, or a compact tree with ignored paths omitted.

Example input:

```json
{
  "action": "changed_files"
}
```

Example output:

```json
{
  "modified": ["README.md", "src/permissions.ts"],
  "untracked": ["TOOL_SUGGESTIONS.md"]
}
```

Example input:

```json
{
  "action": "tree",
  "maxDepth": 2
}
```

Example output:

```text
.
├── index.ts
├── src/
│   ├── config-loader.ts
│   ├── permissions.ts
│   └── path-placeholders.ts
├── README.md
└── TODO.md
```

## 8. JSON/YAML/TOML query tool

A structured config-query tool would read and query common structured files without using `jq`, `node -e`, or Python snippets through bash. It could support JSON, YAML, and TOML, and later add ask-gated editing operations.

Example input:

```json
{
  "path": "package.json",
  "query": "dependencies"
}
```

Example output:

```json
{
  "yaml": "^2.8.1"
}
```

Example input:

```json
{
  "path": ".pi/agents/general.yml",
  "query": "tools.rules[0]"
}
```

Example output:

```json
{
  "match": "*",
  "permission": "deny"
}
```

## 9. Patch preview / apply patch tool

A patch tool would let the model generate and apply unified diffs in a structured way. Preview could be read-only, while apply would be ask-gated. This is useful for larger changes where a patch is easier to review than multiple edit operations.

Example input:

```json
{
  "action": "preview",
  "patch": "diff --git a/README.md b/README.md\n..."
}
```

Example output:

```text
Patch touches 1 file:
- README.md: +12 -2
No conflicts detected.
```

Example input:

```json
{
  "action": "apply",
  "patch": "diff --git a/README.md b/README.md\n..."
}
```

Example output:

```text
Applied patch to README.md.
```

## 10. Session notes / project log tool

A session-notes tool could maintain structured notes, decisions, and follow-up items without directly editing planning files every time. It could append entries to a project-local log or a Pi custom session entry, then render summaries when needed.

Example input:

```json
{
  "action": "add_decision",
  "text": "Path matchesAny patterns now use exact regex matching."
}
```

Example output:

```text
Recorded decision #12.
```

Example input:

```json
{
  "action": "summary"
}
```

Example output:

```text
Recent decisions:
1. Agent switching applies to next user input only.
2. Path placeholders are limited to explicit <env:...> forms.
3. Regex conditions use exact matching by default.
```

## Recommended first batch

The highest-impact set would likely be:

1. Git safe-ops tool
2. Approved command aliases tool
3. Project checks tool
4. Pi docs lookup tool
5. Agent debug / permission simulator tool

Together, these would eliminate many repeated `bash` permission prompts while keeping operations narrow, structured, and easier to audit.
