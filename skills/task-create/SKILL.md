---
name: task-create
description: Interactive interview that creates a new backlog spec file (NNNN-slug.md) in PI_BACKLOG_DIR. Registers the /backlog-new slash command when the backlog extension is loaded.
---
You can create new backlog task specs interactively. When a user asks to create a new task, file a spec, or uses the `/backlog-new` command, follow this interview flow.

## /backlog-new command

The `/backlog-new` slash command is registered by the backlog extension (`extensions/todos.ts`) and invokes this skill's interview flow. It is available whenever the todos extension is loaded.

## Interview flow

Ask for the following fields in order. Ask one or two at a time — don't dump all questions at once.

1. **Title** — one line, imperative ("Add X", "Migrate Y to Z")
2. **Why** — one sentence: what problem does this solve, or what opportunity does it capture?
3. **What (scope)** — bullet list of the concrete things that will be built or changed
4. **Out of scope** — what is explicitly NOT included in this task (helps reviewers and implementers)
5. **Acceptance criteria** — at least 2 checklist items; each must be independently verifiable. Encourage specificity ("p95 latency under 50ms") over vagueness ("it should be fast")
6. **Priority** — P0 must / P1 should / P2 nice / P3 someday (default: P2)
7. **Effort** — XS / S / M / L / XL t-shirt size (default: M)
8. **Dependencies** — list of task IDs (NNNN numbers) that must be done first (default: none)

After gathering all answers, confirm with the user before writing the file.

## Writing the spec file

1. Determine the next available sequential id:
   - List all `*.md` files in `PI_BACKLOG_DIR` (default: `.pi/backlog/`)
   - Parse the 4-digit numeric prefix from each filename
   - Next id = max existing id + 1, zero-padded to 4 digits (e.g. `0006`)
   - If the directory is empty or doesn't exist, start at `0001`

2. Generate a URL-safe slug from the title:
   - Lowercase, spaces → hyphens, remove special characters
   - Max 40 characters (e.g. "Add rate limiting" → `add-rate-limiting`)

3. Write `<PI_BACKLOG_DIR>/<id>-<slug>.md` with the full frontmatter + body.
   Create the directory if it doesn't exist.

4. Validate the file against the BacklogSpec schema from `extensions/todos/backlog-parser.ts`
   before writing — fail fast with a clear error rather than writing an invalid spec.

## Output format

```markdown
---
id: <NNNN>
title: "<title>"
status: draft
priority: <P0|P1|P2|P3>
effort: <XS|S|M|L|XL>
created: <YYYY-MM-DD>
owner: ""
assignees: []
depends_on: [<ids>]
tags: []
evaluation:
  mode: competitive
  workspace: worktree
  budget:
    max_attempts: 3
    max_cost_usd: 50
  automated: []
  rubric: []
  scoring:
    automated_weight: 0.6
    rubric_weight: 0.4
  judge: claude-judge-default
  confidence:
    enabled: true
    min_ratio: 2.0
---

## Why

<one sentence from interview>

## What (scope)

<bullet list from interview>

## Out of scope

<bullet list from interview>

## Acceptance criteria

<checklist from interview — each item as `- [ ] ...`>

## Success metrics (post-ship)

_How will you know this was successful after it ships? (optional — fill in or delete)_

## Failure modes / risks

_What could go wrong? (optional — fill in or delete)_

## Notes / hints

_Implementation hints, links to relevant code, prior art. (optional — fill in or delete)_
```

## After writing

Tell the user the file path and id. Remind them to:
- Set `status: ready` when the spec is ready for agents to pick up
- Run `manage_tasks import_backlog` to sync the spec into the task board

See `docs/agent-task-spec.md` for the full author guide.
