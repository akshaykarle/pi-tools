# @akshaykarle/pi-tools

Pi coding agent extensions for security hardening, sandboxing, task management, and multi-agent orchestration.

## Installation

```bash
pi install @akshaykarle/pi-tools
```

Or add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": ["@akshaykarle/pi-tools"]
}
```

## Extensions

All extensions are registered in `package.json` under `pi.extensions` and load automatically when the package is installed.

### `security.ts`

Defense-in-depth extension that intercepts tool calls and results.

- **Hard blocks:** destructive filesystem commands (`rm -rf /`, `mkfs`, `dd of=/dev`, fork bombs), secret exfiltration (posting env vars or credential files to network), self-protection (cannot remove/modify the agent's extensions, `settings.json`, or `AGENTS.md`).
- **Confirmation prompts:** `sudo`, `chmod`/`chown`, `git push --force`, `git reset --hard`, `git clean -f`, privileged Docker, network listeners.
- **Secret masking:** redacts known secret env-var values from tool output. Covers explicit names plus `*_SECRET`, `*_TOKEN`, `*_API_KEY`, `*_PASSWORD`, `*_CREDENTIAL`, `*_PRIVATE_KEY` patterns.
- **Prompt injection detection:** flags instruction hijacking, fake conversation markers, hidden zero-width Unicode, suspicious markdown image/link exfiltration. Warns rather than blocks to avoid false positives.

### `sandbox.ts`

OS-level sandbox via `@anthropic-ai/sandbox-runtime` plus an in-process tool guard for read/write paths and network domains.

- Per-bash-call wrapping using `SandboxManager.wrapWithSandbox`.
- Config loaded from `~/.pi-${profile}/sandbox.json` and `./.pi-${profile}/sandbox.json` (project overrides user).
- Interactive prompts for blocked domains and write paths, with session/project/global persistence options.
- Adds `--no-sandbox` flag and `/sandbox status|show|validate|reload|off|on` command.
- Always scrubs configured env vars even when sandbox is disabled.

### `todos.ts`

Standalone task-board extension. Provides the `manage_tasks` tool with actions: `add`, `add_batch`, `update`, `list`, `get`. Tasks support dependencies, status (`queued|in-progress|done|failed`), and assignee. Storage directory resolved as: `setActiveTodosDir()` override → `PI_TODO_PATH` env → `.pi/todos/`.

### `agent-teams.ts`

Multi-agent orchestrator. Turns the pi session into a dispatcher that coordinates specialist agents running as separate pi processes. Each agent has its own context window, workspace, and tool allowlist. Includes a live terminal panel widget with per-agent status, tokens, and elapsed time.

Commands: `/team-select`, `/team-list`, `/team-status`, `/team-handoffs`, `/team-off`. Tools (orchestrator-only): `dispatch_agent`, `manage_tasks`.

Supports `shared` and `worktree` workspace modes. Crash recovery detects interrupted runs at startup. Full filesystem layout, agent definition format, skill decision rule, and team config — see [`extensions/agent-teams/README.md`](extensions/agent-teams/README.md).

### `git-worktree.ts`

Standalone git worktree management. Command: `/worktree list | create <name> | switch <name> | remove <path>`. Also adds `--worktree <name>` startup flag (creates if missing, switches into it). Re-exports helper functions consumed by `agent-teams.ts` worktree mode.

### `@plannotator/pi-extension` (bundled)

Bundled from [@plannotator/pi-extension](https://github.com/backnotprop/plannotator). Interactive plan review for coding agents — annotate plans visually, share with your team, and automatically send feedback.

## Skills

Progressive-disclosure skills under `skills/`:

- **`read-only`** — constrains an agent to read-only operations.
- **`workspace-notes`** — instructs the agent to write working notes and output to its workspace directory.

Skills are listed in `package.json` under `pi.skills` and auto-discovered by child pi processes (see the agent-teams skill decision rule).

## Development

This repo uses [nix-direnv](https://github.com/nix-community/nix-direnv). Once installed, run `direnv allow` once — deps from `flake.nix` auto-load on `cd`.

Without direnv: `nix develop` then `npm install`.

### Commands

```bash
npm run build           # compile TypeScript → dist/
npm test                # run all tests once
npm run test:watch      # vitest interactive watch mode
npx tsc --noEmit        # type-check only
npx vitest run path/to/file.test.ts    # run a single test file
npx vitest run -t "name pattern"       # filter tests by name
npm run tui             # launch the agent-teams TUI dashboard
```

### Testing

- Vitest with Node environment. Test files live next to source as `*.test.ts`.
- Excluded paths: `node_modules`, `dist`, `.pi`, `.direnv` (see `vitest.config.ts`).
- Internal helpers are exposed for tests via a `__testing__` export object (e.g. `sandbox.ts`).
- CI (`.github/workflows/test.yml`) runs `npx tsc --noEmit` then `npm test` on Node 22 for every push to `main` and every PR.

### Project layout

```
extensions/        # extension source — each *.ts is registered in package.json
  agent-teams/     # agent-teams internals (loaders, runner, handoff log, ...)
  sandbox/         # sandbox internals (config, path-guard, prompt, session-state)
  git-worktree/    # worktree-manager
  todos/           # task-board
skills/            # progressive-disclosure skills (SKILL.md per skill)
scripts/team-tui/  # TUI dashboard for monitoring agent-teams runs
.pi/agents/        # local agent definitions and teams.yaml (consumed by agent-teams)
```

### Conventions

- ESM-only — imports between local TS files use `.js` extensions (`tsconfig.json` uses `module: ES2022`, `moduleResolution: bundler`).
- Never import implementation details from `@mariozechner/pi-coding-agent` — only its public API surface (it's a `peerDependency`).
- Runtime state in `.pi/agent-teams`, `.pi/plans`, `.pi/todos` is git-ignored.
- Publish is automated: GitHub release → `.github/workflows/publish.yml` → npm with provenance.

## License

MIT
