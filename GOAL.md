# Overall Goal
I'd like to implement an agent system for Pi similar to OpenCode.
An agent will consist of a set of tools with related permissions, a set of skills that the agent can perform, and a set of goals that the agent is trying to achieve.
Instructions on how a tool is to be used is supposed to be provided in the tool definition according to the Pi documentation, but please double check this.

## Agents
- An agent will have a name, a description, a set of tools that it can use, a set of skills that it can perform, default and fallback models, and an agent prompt.
- We are not yet trying to implement a subagents system. The agents are meant for interactive use for the user.
- The name of the currently-active agent should be visible in the TUI, as a label for the input editor.
- Users should be able to type `/agents` in the Pi editor, to select an agent from the list of configured agents, and the selected agent will then become the active agent.
- Agent definitions should be specified as yaml files in a specific global directory, and Pi should be able to load these agent definitions at runtime.
- Users can override global agent definitions in a per-project agent definition file that is merged with the global definition.
- Per-project agents can be loaded from `<cwd>/.pi/agents/<agent-definition-file>.yml`.
- Agents should be able to use only the tools that are specified in their definition, and they should be able to perform only the skills that are specified in their definition.
- Skills and tools can also be matched with regex patterns, to enable specifying permissions for a set of tools or skills at once.
- Agent definitions should be hot-reloadable with the `/reload` command that Pi uses to reload its own configuration.

## Tool Permissions
Pi comes with a set of inbuilt tools, and I'd like to implement a permissions system for these tools as well as other tools that may be added in the future.
The permissions system should allow users to control which tools can be used and under what circumstances, specific to each agent and project.
Here's a rough outline of how I envision the permissions system:

- Each agent has a set of tools it is allowed to use, and each tool comes with an associated permission.
- Permissions are either `allow`, `deny`, and `ask`.
- Permissions can depend on tool parameters.
- Permissions are not specified in the tool itself, but rather in agent definitions.
- Permissions can also target the `mcp` proxy tool, and tools exposed as mcp servers.
- Permissions can target the `doom_loop`: that is, a tool called with the same inputs multiple times. The number of identical tool calls should be configurable.

## Skill permissions
- Each skill is either `allow`, `deny`, or `ask`.

## Default agent
To begin with, we will have a `General` agent with the following tool permissions:

- Disable all read/write/edit/grep/find/ls operations outside current directory.
- Allow all read-only operations (read, grep, find, and ls) in current directory.
- Ask for write permissions (write, edit) in current directory.
- Disable any bash command starting with `rm`, `sudo`, `chmod`, `chown`, `dd`, `mkfs`, `mount`, `umount`, `kill`, `pkill`, `killall`, `shutdown`, `reboot`, and any other potentially dangerous commands.
- Ask for all other bash commands.

This agent does not have any skills by default.
