# Agent Teams Extension

Orchestrate teams of AI agents that collaborate on shared tasks with explicit, auditable handoffs and crash-resilient filesystem-based state.

## Quick Start

1. Create agent definitions in `.pi/agents/`:

```markdown
<!-- .pi/agents/researcher.md -->
---
name: researcher
description: Explores codebases and produces research summaries
tools: read,grep,find,ls,bash
---
You are a research specialist. Never modify files.
```

2. Define teams in `.pi/agents/teams.yaml`:

```yaml
dev-team:
  description: "Development team"
  workspaceMode: shared    # or "worktree" for git worktree isolation
  maxConcurrency: 2
  members:
    - researcher
    - implementer
    - reviewer
```

3. Run pi with the extension:

```bash
pi -e extensions/agent-teams.ts
```

## How It Works

The extension turns your pi session into an **orchestrator** that coordinates specialist agents:

```
┌─────────────────────────────────────┐
│  Orchestrator (your pi session)     │
│  Tools: dispatch_agent, manage_tasks│
│                                     │
│  ┌──────────┐  ┌──────────┐        │
│  │Researcher│  │Implementer│        │
│  │(child pi)│  │(child pi) │        │
│  └──────────┘  └──────────┘        │
│                                     │
│  Shared: tasks.json, handoffs.ndjson│
└─────────────────────────────────────┘
```

- **Orchestrator** breaks down your request into tasks and dispatches agents
- **Agents** run as separate pi processes with their own tools and context
- **Task board** tracks all work (`.pi/agent-teams/runs/<team>/<run>/tasks.json`)
- **Handoff log** provides an audit trail (both `.ndjson` and human-readable `.md`)
- **Workspaces** give each agent their own session/notes directory

## Agent Definition Format

Agent `.md` files use YAML frontmatter:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique agent name (lowercase, kebab-case) |
| `description` | No | What the agent does |
| `tools` | No | Comma-separated allowlist (e.g. `read,grep,find,ls`) |
| `disallowedTools` | No | Comma-separated denylist (mutually exclusive with `tools`) |
| `model` | No | Default model for this agent (e.g. `anthropic/claude-haiku-4-5`). Overrides the parent session model. Can itself be overridden per-dispatch via the `model` param on `dispatch_agent`. |
| `extensions` | No | Controls which extensions load in the child process. **Absent** (default): all project extensions load, skills auto-discover — no `skills:` needed. **Empty** (`extensions:`): `--no-extensions`, no extensions load, skills no longer auto-discover — use `skills:` to list what the agent needs. **List** (`extensions: security, sandbox`): only named extensions load, same skills caveat — use `skills:`. Names matched case-insensitively against basenames in `package.json pi.extensions`. See [Skills](#skills) for the full decision rule. |
| `skills` | No | Comma-separated skill names to force-preload (e.g. `read-only, workspace-notes`). **Only set this when `extensions:` is also set** (empty or a list). When `extensions:` is absent, omit `skills:` entirely — skills auto-discover natively. See [Skills](#skills). |

The markdown body becomes the agent's system prompt.

### Examples

**Default — `extensions:` absent, `skills:` absent (most agents)**

All project extensions load (agent-teams is guarded against recursion). All project skills auto-discover natively. Nothing extra to declare.

```markdown
---
name: researcher
description: Explores codebases and produces research summaries
tools: read,grep,find,ls,bash
model: anthropic/claude-haiku-4-5
---
You are a research specialist.
```

**Restricted extensions — `extensions:` list, `skills:` required**

Only the named extensions load. Because `--no-extensions` is passed, `pi.skills` package paths are suppressed. List every skill the agent needs.

```markdown
---
name: sandboxed-worker
description: Runs with only security and sandbox extensions
tools: read,write,edit,bash
extensions: security, sandbox
skills: workspace-notes
---
You are a sandboxed implementation agent.
```

**Fully isolated — `extensions:` empty, `skills:` required**

No extension `.ts` files load at all. Skills must be listed explicitly — they will not auto-discover.

```markdown
---
name: isolated-agent
description: Fully isolated, no extensions
extensions:
skills: read-only
---
You are a read-only agent with no extensions.
```

## Team Config Format

```yaml
team-name:
  description: "Team description"
  workspaceMode: shared      # "shared" or "worktree"
  cleanupWorktree: false     # true = remove worktree checkout on run-end (branch kept)
  maxConcurrency: 2          # Max parallel agents
  members:
    - agent-name-1
    - agent-name-2
```

## Skills

### Decision rule: when to use `skills:`

| `extensions:` field | Skills behaviour | Use `skills:`? |
|---|---|---|
| **Absent** (default) | All project skills auto-discover natively via pi’s progressive disclosure. The child process scans `pi.skills` directories at startup. | **No — omit `skills:`** |
| **Empty** (`extensions:`) | `--no-extensions` is passed. Package-declared `pi.skills` paths are suppressed and skills no longer auto-discover. | **Yes — list every skill the agent needs** |
| **List** (`extensions: security, sandbox`) | `--no-extensions` is passed. Same suppression applies. | **Yes — list every skill the agent needs** |

In short: **`skills:` is only ever needed alongside `extensions:`**. If you haven’t set `extensions:`, don’t set `skills:` either.

```yaml
# ✔ Correct — extensions absent, skills absent: auto-discovery handles everything
name: researcher
tools: read,grep,find,ls,bash

# ✔ Correct — extensions restricted, skills explicitly listed
name: sandboxed-worker
extensions: security, sandbox
skills: read-only, workspace-notes

# ✘ Wrong — redundant: skills will auto-discover anyway when extensions is absent
name: researcher
skills: read-only, workspace-notes  # unnecessary
```

### How native skill discovery works

Child agents use pi’s **progressive disclosure** skill system. At startup, the child process scans the `pi.skills` directories declared in `package.json` and injects stubs into its system prompt:

```xml
<skill name="read-only" location="./skills/read-only/SKILL.md">
Constrains the agent to read-only operations
</skill>
```

The agent loads the full `SKILL.md` on-demand via its `read` tool (or `/skill:name` command) when it needs it. Only descriptions are always in context; full instructions are fetched lazily.

Skills are declared in `package.json`:

```json
"pi": { "skills": ["./skills", "node_modules/some-pkg/skills"] }
```

Each skill is a directory containing a `SKILL.md`:

```
skills/
  read-only/
    SKILL.md
  workspace-notes/
    SKILL.md
```

When `skills:` is set, each named skill is resolved to its directory path and passed as `--skill <dir>` to the child process, bypassing package discovery. Missing skills produce a warning notification but do not fail the dispatch.

## Commands

| Command | Description |
|---------|-------------|
| `/team-select` | Switch active team (re-engages orchestrator mode if team has members) |
| `/team-off` | Disable team mode and restore full tool access |
| `/team-list` | List agents in the active team |
| `/team-status` | Show run status and task board |
| `/team-handoffs` | View the handoff audit log |

## Tools (for the orchestrator LLM)

| Tool | Description |
|------|-------------|
| `dispatch_agent` | Send a task to a specialist agent. Optional `model` param overrides the agent's model for this dispatch. |
| `manage_tasks` | Add/update/list/get tasks on the shared board |

## Workspace Modes

- **`shared`** — All agents work in the project directory. Simplest, but agents may conflict on files.
- **`worktree`** — All agents in a run share **one** git worktree (branch named after the run ID), isolating their work from the main branch. Requires a clean working tree at dispatch time. Set `cleanupWorktree: true` on the team to remove the checkout directory (branch is preserved) when the run ends.

## Filesystem Layout

```
.pi/
  agents/
    researcher.md          # Agent definition
    implementer.md         # Agent definition
    teams.yaml             # Team definitions
  agent-teams/
    runs/
      <team-name>/
        <run-id>/
          run.json         # Run metadata
          tasks.json       # Shared task board
          handoffs.ndjson  # Machine-readable handoff log
          handoffs.md      # Human-readable handoff audit trail
          workspaces/
            <agent-name>/
              session.json # Pi session (crash recovery)
              notes.md     # Agent's working notes
              output.md    # Agent's output
```

## Crash Recovery

On startup, the extension scans for interrupted runs (runs with status "running" that have in-progress or queued tasks). You'll see a notification with details about what was interrupted.

## Git Worktree Extension

The `git-worktree.ts` extension is standalone and can be used independently:

```bash
pi -e extensions/git-worktree.ts
```

Commands: `/worktree list`, `/worktree create <name>`, `/worktree remove <path>`
