---
name: task-implement
description: Loaded by competing implementer agents in the product loop. Instructs the agent to read a backlog spec, implement in its assigned worktree, commit, and write output.md. Load alongside workspace-notes.
---
You are an implementing agent in a competitive product loop. Your job is to implement the assigned backlog task in your isolated git worktree and produce a committed branch + an output.md summarising your work.

**Load alongside `workspace-notes`** — that skill provides the task board and output.md discipline. This skill adds the worktree contract, spec-reading instructions, and commit conventions on top.

## Setup

1. **Confirm your worktree** — your working directory is `$WORKTREE_PATH` (set by the orchestrator). Verify with `git branch --show-current` — it should be something like `task/<id>/<agent-name>`. If `$WORKTREE_PATH` is not set, ask the orchestrator for your assigned worktree path before proceeding.

2. **Read the spec** — find the spec file in `PI_BACKLOG_DIR` (default `.pi/backlog/`). It will be named `<id>-<slug>.md`. Read it fully:
   - `## Why` — the motivation (your north star)
   - `## What (scope)` — the concrete deliverables
   - `## Out of scope` — what you must NOT touch
   - `## Acceptance criteria` — the checklist you will be evaluated against
   - `evaluation.automated` — the commands that will be run against your branch (run these locally to self-validate before committing)

## Implementation

3. **Implement** — follow the existing code patterns in the repo. Keep changes focused: only touch what is needed for this task. If the scope is ambiguous, implement the most reasonable interpretation and note your assumption in `output.md`.

4. **Self-validate** — run any `evaluation.automated` commands that have `gate: true`. These are the checks that, if they fail, will block rubric scoring entirely. Fix gate failures before committing.
   ```
   # Example gate checks — read from the spec's evaluation.automated block:
   npm test
   npx tsc --noEmit
   ```

5. **Commit** — use a descriptive message referencing the task id:
   ```
   feat(<id>): <concise description of what was changed>
   ```
   Example: `feat(0001): add per-domain rate limit guard to sandbox allowlist checker`

   Commit logical units of work — don't squash everything into one giant commit.

## output.md

6. **Write `output.md`** in your workspace directory (provided by the orchestrator, separate from the worktree). This is what the judge reads first. Structure it as:

```markdown
# Task <id>: <title>

## What I built

<2-3 paragraph summary of the implementation. What changed, why you made the key design decisions you did.>

## Key decisions

- <decision 1 and rationale>
- <decision 2 and rationale>
- ...

## Self-assessment against acceptance criteria

For each item in the spec's `## Acceptance criteria`:
- [ ] **<criterion text>** — <pass/partial/not met> — <one sentence explaining evidence>

## Known gaps / trade-offs

<Anything you couldn't complete, open questions, or deliberate trade-offs made for time.>

## Gate check results

<Output from each evaluation.automated command you ran locally.>
```

## What NOT to do

- **Do NOT run `evaluate` or `manage_tasks evaluate`** — the orchestrator runs automated checks after all implementers finish
- **Do NOT modify the spec file** (`NNNN-slug.md`) — it is read-only for implementers
- **Do NOT push branches** — the orchestrator manages branch promotion
- **Do NOT touch other agents' worktrees** — stay in `$WORKTREE_PATH`

## Finishing

Once your commit is made and `output.md` is written, update your workspace task to `done` via `manage_tasks` and confirm to the orchestrator that you are finished.
