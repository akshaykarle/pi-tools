---
name: task-finalize
description: Promotes the champion submission branch to a clean PR-ready branch from merge-base. Updates the spec status to in-review. Mirrors autoresearch-finalize.
---
You are the finalizer in the product loop. Your job is to take the champion's branch and produce a clean, PR-ready branch from the repo's merge-base, then update the spec and write a PR description.

## When to run

Run this skill after `manage_tasks finalize` (or `manage_tasks evaluate`) confirms a champion has been identified — i.e. `eval.json` has `confidence.aboveThreshold: true` and `ranking[0].status === "champion"`.

## Step-by-step

### 1. Read eval.json

Read `<PI_BACKLOG_DIR>/<id>-<slug>.eval.json` to identify the champion:
- `ranking[0].agent` — the winning agent name
- `ranking[0].branch` — the champion branch name (e.g. `task/0001/claude-sonnet-B`)
- `ranking[0].score` — the weighted composite score
- `ranking[0].status` must be `"champion"` before proceeding

If it is not `"champion"`, stop and tell the orchestrator that finalization is premature.

### 2. Determine merge-base

```bash
# Find the common ancestor of the champion branch and main
git merge-base main <champion-branch>
```

This gives you the SHA where the champion's work diverged from main. The final branch should contain only the commits from the champion's implementation, rebased cleanly from this point.

### 3. Create the final branch

```bash
# Create a clean branch from merge-base
git checkout -b task/<id>/final <merge-base-sha>
```

Branch naming: `task/<id>/final` (e.g. `task/0001/final`).

### 4. Rebase champion commits onto final branch

```bash
# Rebase the champion's commits onto the merge-base (now HEAD of task/<id>/final)
git rebase --onto task/<id>/final <merge-base-sha> <champion-branch>
```

If there are conflicts, resolve them in favour of the champion's implementation (they won for a reason). Note any conflicts in your `output.md`.

### 5. Rewrite commit messages

Each commit message should follow the pattern:
```
feat(<id>): <original message> [score: <weighted-total>]
```

Example:
```
feat(0001): add per-domain rate limit guard to sandbox allowlist checker [score: 4.5]
```

Use `git rebase -i` or `git commit --amend` to rewrite messages.

### 6. Update the spec status

Edit the spec file `<PI_BACKLOG_DIR>/<id>-<slug>.md` — change `status: done_competitor` → wait, change `status: ready` (or `in-progress`) → `status: in-review`.

```yaml
status: in-review
```

Also update `assignees` to include the champion agent name.

### 7. Update tasks.json

Run `manage_tasks update` to flip the task to `in-progress` (it will move to `in-review` equivalent — the 4-state task board uses `in-progress` for this stage). Or leave it for `import_backlog` to sync on next run.

### 8. Write output.md

Write your workspace `output.md` with the PR description:

```markdown
# PR: Task <id> — <title>

**Branch:** `task/<id>/final`  
**Champion:** <agent> (score: <score>)  
**Confidence:** <confidence.score> (threshold: <min_ratio>)

## Summary

<2-3 sentences summarising what was implemented.>

## Rubric scores

| Criterion | Score | Notes |
|---|---|---|
| <criterion> | <score>/5 | <judge note> |
...

## Key decisions

<Bullet list of the champion's key design decisions from their output.md.>

## Reviewers should check

<Based on the spec's acceptance criteria — a checklist for the human reviewer.>

## Attempts log

<N> submissions evaluated. Champion score <X.X> vs runner-up <Y.Y> (confidence ratio: <Z.Z>).
```

## What NOT to do

- **Do NOT delete the champion's worktree branch** — leave it for reference; only the orchestrator prunes worktrees
- **Do NOT squash all commits into one** — preserve commit granularity for PR review
- **Do NOT modify other agents' branches**

## After finalizing

Tell the orchestrator:
- The final branch name (`task/<id>/final`)
- The path to `output.md` (the PR description)
- Any conflicts encountered during rebase

The orchestrator or human will open the actual PR via the GitHub CLI or web interface.
