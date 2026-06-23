# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

## What this is

`@akshaykarle/pi-tools` — a package of extensions and skills for the **pi coding agent** (`@earendil-works/pi-coding-agent`). Extensions are TypeScript modules that hook into pi's tool-call lifecycle; skills are progressive-disclosure markdown files. Published to npm as a `pi-package`.

## Commands

```bash
npm run build          # tsc → dist/
npm test               # vitest run
npm run test:watch     # vitest interactive
npx vitest run path/to/file.test.ts          # single test file
npx vitest run -t "regex"                    # filter by test name
npx tsc --noEmit       # type-check only (CI uses this)
npm run tui            # launch agent-teams TUI dashboard (separate terminal)
```

Dev shell: `direnv allow` (uses `flake.nix`) or `nix develop`. Provides Node 22 + ts-language-server.

CI (`.github/workflows/test.yml`) runs `npx tsc --noEmit` then `npm test` on Node 22. `publish.yml` fires on GitHub release with npm provenance.

## Architecture

### Extensions register against `ExtensionAPI`

Each `extensions/*.ts` exports a default function `(pi: ExtensionAPI) => void`. The pi runtime calls it during session start, and the extension wires up:
- `pi.on("tool_call" | "tool_result" | "session_start" | "session_shutdown" | "user_bash" | "before_agent_start", handler)` — lifecycle hooks
- `pi.registerTool(...)`, `pi.registerCommand(...)`, `pi.registerFlag(...)` — capabilities
- `pi.setActiveTools([...])` — narrow the toolset (used by orchestrator mode)

Returning `{ block: true, reason }` from a `tool_call` hook vetoes the call.

### Extensions in this package (registered in `package.json` → `pi.extensions`)

| Extension | Role |
|---|---|
| `security.ts` | Defense-in-depth: hard-blocks destructive/exfil bash patterns, prompts to confirm sudo/chmod/force-push, redacts secret env-var values from tool output, flags prompt-injection markers in results. |
| `sandbox.ts` | OS-level sandbox via `@anthropic-ai/sandbox-runtime` + in-process tool guard. Per-bash-call wrapping. Reads config from `.pi-${profile}/sandbox.json`. Adds `--no-sandbox` flag, `/sandbox` command. Helpers in `extensions/sandbox/`. |
| `todos.ts` | `manage_tasks` tool over a JSON task board on disk. Active dir resolved via `setActiveTodosDir()` > `PI_TODO_PATH` > `.pi/todos/`. |
| `agent-teams.ts` | Orchestrator mode — turns the pi session into a dispatcher. Registers `dispatch_agent`, narrows tools to orchestrator-only, spawns child pi processes per agent. |
| `git-worktree.ts` | `/worktree` command + helpers re-exported for `agent-teams` worktree mode. |
| `@plannotator/pi-extension` | Bundled via `bundledDependencies`. Interactive plan annotator. |

### Plain session vs orchestrator mode

**This distinction matters — get it wrong and you'll waste round-trips.**

| Mode | How to tell | Available tools | What to do |
|---|---|---|---|
| **Plain pi session** | No team selected; full tool access | `read`, `bash`, `grep`, `find`, `ls`, `write`, `edit`, … | Use tools directly |
| **Orchestrator mode** | Team selected via `/team-select`; tools narrowed to `dispatch_agent` + `manage_tasks` | `dispatch_agent`, `manage_tasks` | Dispatch agents for all work |

**Rules:**
- In a plain session, **never reach for `dispatch_agent`** — use your tools directly (`read`, `bash`, `grep`, etc.).
- `dispatch_agent` requires an active run. An active run only exists after `/team-select` starts a team session.
- **The agent-teams extension being installed does not mean a team is active.** The extension loading and orchestrator mode are separate things.
- If `dispatch_agent` returns *"No active run"*, you are in a plain session — switch to direct tools immediately.

### Agent-teams flow (most architecturally significant)

The orchestrator pattern is the largest single piece of logic — read `extensions/agent-teams/README.md` for the full contract.

```
.pi/agents/*.md          # agent definitions (YAML frontmatter + system prompt body)
.pi/agents/teams.yaml    # team membership + workspaceMode (shared|worktree) + maxConcurrency
.pi/agent-teams/runs/<team>/<run-id>/
    run.json
    tasks.json           # shared board (manage_tasks writes here)
    handoffs.{ndjson,md} # audit log of dispatch/completion/failure
    workspaces/<agent>/  # session.json, notes.md, output.md
```

Key invariants:
- Child agents are separate `pi` processes spawned by `agent-runner.ts`. They set `PI_AGENT_TEAMS_CHILD=1` so `agent-teams.ts` short-circuits and does not become a recursive orchestrator.
- Skill resolution rule (decision matrix in `extensions/agent-teams/README.md`): if an agent's frontmatter sets `extensions:` (empty or list), pi runs with `--no-extensions` and package skill auto-discovery is suppressed — the agent must list every needed skill in `skills:`. If `extensions:` is absent, omit `skills:` entirely.
- Worktree mode requires a clean working tree. All agents in a run share **one** worktree named `<runId>`. Set `cleanupWorktree: true` in `teams.yaml` to remove the checkout directory (not the branch) on run-end.
- `_activeTodosDir` module state in `todos.ts` is set by `agent-teams.ts` so `manage_tasks` writes into the run dir instead of `.pi/todos/`.

### Sandbox precedence quirk

`@anthropic-ai/sandbox-runtime` uses `allowRead > denyRead` but `denyWrite > allowWrite`. Our in-process tool guard (`extensions/sandbox/path-guard.ts`) uses `denyRead > allowRead` (safer). The OS layer behaves differently — accepted limitation, called out in `sandbox.ts` header.

### Self-protection

`security.ts` hard-blocks `rm`/`write`/`edit` against paths under `<agentDir>/agent/extensions/`, `settings.json`, `AGENTS.md`. The agent dir is derived from `getAgentDir()` (so `.pi-personal`, `.pi-sahaj`, `.pi-client` profile wrappers all work).

## Conventions

- Tests live next to source: `foo.ts` + `foo.test.ts`. Vitest excludes `node_modules`, `dist`, `.pi`, `.direnv`.
- Module imports use `.js` extensions even from `.ts` (ESM bundler resolution; `tsconfig.json` `module: ES2022`, `moduleResolution: bundler`).
- Internal helpers exposed for tests via a `__testing__` export object (see `sandbox.ts`).
- `peerDependencies: @earendil-works/pi-coding-agent` — never import implementation details, only types/public API surface.
- `.gitignore` excludes `.pi/agent-teams`, `.pi/plans`, `.pi/todos` — these are runtime state, not config.
- Build artefacts (`*.js`, `*.d.ts`, `*.js.map`) are gitignored but published from `dist/` per `package.json files`.
- **Test every call-site, not just the function.** When a helper is called from N places, write N tests — one per call-site. A plan step that says "call X at every Y" is an N-site obligation: the test spec must list a case for each site explicitly. A passing test on one path gives no signal about sibling paths; untested call-sites must be flagged as explicitly out-of-scope, not left as implicit gaps.

## Picking up work from `.pi/backlog/`

The backlog is a directory of task spec files — each `.md` is a mini-PRD with YAML frontmatter (machine-readable) and a markdown body (human-readable). Teams of agents pick up `ready` specs, implement them in competing git worktrees, and submit for evaluation by a judge agent. Full author and judge guide: `docs/agent-task-spec.md`.

### Where specs live

- Default location: `.pi/backlog/` (override with `PI_BACKLOG_DIR` env var — same precedence rule as `PI_TODO_PATH`)
- Naming: `NNNN-slug.md`, e.g. `0001-rate-limiting.md`
- Companion files auto-generated during a run:
  - `NNNN-slug.attempts.jsonl` — append-only log, one row per competing submission
  - `NNNN-slug.eval.json` — current ranked results + confidence score (regenerable)

### Key frontmatter fields (agents must read these)

| Field | What to check |
|---|---|
| `status` | Only pick up tasks where `status: ready` or `status: in-progress` |
| `depends_on` | List of task IDs that must be `done` first; do not start if any are not |
| `evaluation.mode` | `solo` (one agent) / `coordinated` (agents split the work) / `competitive` (agents implement independently, best wins) |
| `evaluation.automated` | Commands the **orchestrator** runs after all implementations finish — not the implementing agent |
| `evaluation.rubric` | Scoring criteria for the judge; if absent or empty, the judge falls back to assessing each AC |
| `evaluation.budget` | `max_attempts` and `max_cost_usd` caps; orchestrator enforces these before each new dispatch round |

### Implementer contract

1. Read the full spec — `## Why`, `## What (scope)`, and `## Acceptance criteria` are the ground truth.
2. Work only in your assigned worktree: `<repoRoot>/.worktrees/<agent>-<task-id>/`.
3. Implement, then commit with a message referencing the task id (e.g. `feat(0001): add rate-limit guard`).
4. Write `output.md` in your workspace: what you built, key decisions, self-assessment against each AC, any known gaps.
5. Do **not** run `evaluation.automated` commands — the orchestrator does that after all implementers finish.

### Judge contract

1. Receive a task prompt from the orchestrator containing: spec path + a JSON manifest of candidates `{ agent, branch, worktree_path, output_md_path, automated_results }`.
2. Use only `read`, `find`, `grep`, `ls` tools — no `bash`, no file writes of any kind.
3. For any candidate where a `gate: true` automated check failed: mark `status: gated`, skip rubric scoring.
4. If `evaluation.rubric` is defined: score each criterion 1–5 with a one-sentence justification.
5. If `evaluation.rubric` is absent or empty: assess each `## Acceptance criteria` item against the implementation and produce a single `ac_satisfaction` score 1–5.
6. Emit exactly one JSON object per candidate matching the `*.attempts.jsonl` schema — no prose outside the JSON.

### Full guide

`docs/agent-task-spec.md` — frontmatter field reference, the full orchestrator loop diagram, budget controls, confidence scoring via MAD, and worked examples of automated vs AC-fallback scoring.
