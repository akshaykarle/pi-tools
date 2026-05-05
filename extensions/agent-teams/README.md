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
| `skills` | No | Comma-separated list of skill names to inject into this agent's system prompt (e.g. `safe-bash, workspace-notes`). Skills are discovered from the `pi.skills` directories in `package.json`. |

The markdown body becomes the agent's system prompt.

### Example with all fields

```markdown
---
name: researcher
description: Explores codebases and produces research summaries
tools: read,grep,find,ls,bash
model: anthropic/claude-haiku-4-5
skills: read-only, workspace-notes
---
You are a research specialist.
```

## Team Config Format

```yaml
team-name:
  description: "Team description"
  workspaceMode: shared      # "shared" or "worktree"
  maxConcurrency: 2          # Max parallel agents
  members:
    - agent-name-1
    - agent-name-2
```

## Skills

Skills are reusable `SKILL.md` snippets injected into an agent's system prompt at spawn time. They let you share common instructions across agents without copy-pasting.

Skills are discovered from the `pi.skills` directories declared in `package.json` (project-first precedence):

```json
"pi": { "skills": ["./skills", "node_modules/some-pkg/skills"] }
```

Each skill is a directory containing a `SKILL.md` file:

```
skills/
  safe-bash/
    SKILL.md       # "Be careful with bash — never use rm -rf etc."
  read-only/
    SKILL.md       # "You are READ-ONLY. Never modify files."
  workspace-notes/
    SKILL.md       # "Write your working notes to your workspace notes file."
```

Skill content is wrapped in XML tags and appended to the agent's system prompt:

```xml
<skill name="safe-bash">
Be careful with bash. Never use rm -rf, truncate, or other destructive commands.
</skill>
```

Missing skills produce a warning notification but do not fail the dispatch.

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
- **`worktree`** — Each agent gets a git worktree branch. Requires the `git-worktree` extension and a clean working tree. Best for parallel write operations.

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
