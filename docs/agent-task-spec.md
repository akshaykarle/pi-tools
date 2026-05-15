# Agent Task Spec — Author & Judge Guide

This system is **pi-autoresearch for product ideas instead of scalar metrics**: rather than
minimising a benchmark number, it dispatches competing agent implementations against a
product spec, scores them with automated checks and a judge agent, and promotes the best
submission. Specs live in `PI_BACKLOG_DIR` (default `.pi/backlog/`, overridable to e.g.
`backlog/` for version-controlled specs), each as a self-contained markdown file with YAML
frontmatter. They connect directly to the existing `agent-teams` infrastructure — competing
agents run in worktrees, the judge is a regular read-only agent, and the task board
(`manage_tasks`) imports frontmatter losslessly.

---

## When to file a task

**Yes, file a task when:**

- You have a product idea or feature you want agents to implement and you want to pick the
  best result.
- There is design ambiguity — more than one reasonable implementation approach exists.
- You want reproducible, auditable evaluation: automated checks + a scored rubric that can
  be re-run or disputed.
- You want to track effort, priority, and dependencies across a backlog of work.
- You want agents to compete (`mode: competitive`) or coordinate (`mode: coordinated`) on
  the same problem.
- The task is non-trivial enough that a fresh agent needs written context to pick it up
  without you re-explaining it.

**No need to file a task when:**

- The fix is trivial and obviously correct (typo, one-liner, no design decision).
- It's a pure refactor with zero observable behaviour change and no design ambiguity.
- The work is so exploratory that acceptance criteria can't be written yet — use a scratch
  note or a `draft` spec stub until they crystallise.
- It's a one-off investigation that won't become a PR.

---

## Quick start

1. **Copy** `.pi/backlog/TEMPLATE.md` → `.pi/backlog/NNNN-your-slug.md`
   (use the next sequential four-digit number).
2. **Fill the frontmatter** — at minimum: `id`, `title`, `priority`, `effort`, `created`,
   and at least two `## Acceptance criteria` items. Everything else has sensible defaults.
3. **Set `status: ready`** when the spec is complete enough for an agent to act on.

> **Coming soon:** `/backlog-new` — a slash command that interviews you interactively
> (title, why, scope, ACs, priority, effort) and writes the pre-filled file automatically.
> Tracked in `.pi/backlog/0002-backlog-tooling.md`.

---

## Frontmatter field reference

### Core fields

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `id` | string | — | ✓ | Zero-padded sequential number matching the filename (`0007` for `0007-slug.md`). Also used as the human-facing task handle throughout the system. |
| `title` | string | — | ✓ | One-line description of the task. Shown in dashboards and task boards. |
| `status` | enum | `draft` | ✓ | Lifecycle state — see [Status lifecycle](#status-lifecycle). |
| `priority` | enum | `P2` | ✓ | `P0` must-ship · `P1` should-ship · `P2` nice-to-have · `P3` someday/maybe. |
| `effort` | enum | `M` | ✓ | T-shirt size: `XS` · `S` · `M` · `L` · `XL`. |
| `created` | date | — | ✓ | ISO date (`YYYY-MM-DD`) the spec was first written. |
| `owner` | string | `""` | — | GitHub handle or name of the human author responsible for this spec. |
| `assignees` | string[] | `[]` | — | Agent IDs once dispatched. Filled automatically by the orchestrator; leave empty when authoring. |
| `depends_on` | string[] | `[]` | — | IDs of other specs that must reach `done` before this one can be dispatched. |
| `tags` | string[] | `[]` | — | Free-form labels for filtering and grouping (e.g. `[api, security]`). |

### `evaluation` block

The `evaluation` block is optional. Omitting it entirely is valid — the judge falls back to
assessing acceptance criteria directly (see [AC fallback](#worked-examples)).

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `evaluation.mode` | enum | `competitive` | — | `solo` — one agent, evaluated against ACs. `coordinated` — agents collaborate. `competitive` — agents work independently and are ranked against each other. |
| `evaluation.workspace` | enum | `worktree` | — | Maps to `agent-teams` workspace mode. `worktree` gives each implementer an isolated git branch at `<repoRoot>/.worktrees/<agent>-<task-id>`. |
| `evaluation.budget.max_attempts` | int | `3` | — | Maximum rounds of competing submissions. The orchestrator checks this before dispatching a new round. Set to `null` to remove this cap. |
| `evaluation.budget.max_cost_usd` | float | `50` | — | Cumulative USD spend cap across all attempts and sessions for this task. The orchestrator sums costs from `*.attempts.jsonl` (pi reports token costs in its JSON output) and hard-stops before dispatching if the running total would exceed this. Set to `null` to remove. **Whichever limit hits first wins.** |
| `evaluation.automated` | object[] | `[]` | — | Commands run by the **orchestrator** (not the judge) before rubric scoring. Results are passed to the judge in the task prompt. Each entry: `{id, cmd, gate?, parse?, target?}` — see below. |
| `evaluation.automated[].id` | string | — | ✓ | Identifier used as the key in `*.attempts.jsonl`'s `automated` object (e.g. `"tests"`, `"types"`, `"p95_latency"`). |
| `evaluation.automated[].cmd` | string | — | ✓ | Shell command the orchestrator runs from the candidate's worktree root. |
| `evaluation.automated[].gate` | bool | `false` | — | If `true`, a non-zero exit code marks the submission `gated` and skips rubric scoring for that candidate entirely — equivalent to `autoresearch.checks.sh`. |
| `evaluation.automated[].parse` | string | — | — | Pattern to extract a numeric value from stdout, e.g. `"P95_MS=<num>"`. The `<num>` placeholder is replaced with the captured value. |
| `evaluation.automated[].target` | string | — | — | Pass/fail threshold for the parsed numeric value, e.g. `"<= 50"`. If the value does not meet the target, the check is recorded as failed (but only blocks scoring if `gate: true`). |
| `evaluation.rubric` | object[] | `[]` | — | Criteria for the judge to score 1–5. **Weights must sum to 1.0.** Omit entirely (or leave empty) to use AC fallback scoring. Each entry: `{id, weight}`. |
| `evaluation.rubric[].id` | string | — | ✓ | Criterion identifier used as the key in `*.attempts.jsonl`'s `rubric` object. |
| `evaluation.rubric[].weight` | float | — | ✓ | Fractional weight (0–1). All weights in the list must sum to exactly 1.0. |
| `evaluation.scoring.automated_weight` | float | `0.6` | — | Fraction of the final score derived from automated checks. Must sum to 1.0 with `rubric_weight`. |
| `evaluation.scoring.rubric_weight` | float | `0.4` | — | Fraction of the final score derived from judge rubric scores. |
| `evaluation.judge` | string | `claude-judge-default` | — | Name of a `.pi/agents/<name>.md` agent profile to dispatch as judge, or the literal string `"human"` to skip automated judging and surface a manual review prompt. |
| `evaluation.confidence.enabled` | bool | `true` | — | Whether to compute and surface a confidence score after evaluation. |
| `evaluation.confidence.min_ratio` | float | `2.0` | — | The winner's score gap over the runner-up must be ≥ `min_ratio × MAD` for the result to be considered clear. Below this threshold, `evaluate` surfaces "rerun recommended" (no auto-dispatch in v1). |

---

## Acceptance criteria style guide

**Free-form checklists are the default.** Use `- [ ]` items in `## Acceptance criteria`.
Given/When/Then (G/W/T) structure is encouraged for behaviour-change tasks but not required.

**Make criteria independently verifiable.** Each item should be checkable by a fresh agent
(or the judge) without additional context. Aim for concrete and measurable over vague and
aspirational.

| ❌ Vague | ✓ Specific |
|---|---|
| "It should be fast." | "p95 latency under 50 ms on `scripts/bench.js`." |
| "Tests should pass." | "All existing sandbox tests pass: `npm test -- sandbox`." |
| "The config should be backward-compatible." | "An existing `sandbox.json` without the new field loads without error." |
| "The feature is documented." | "The new `rateLimits` option is described in a `sandbox.json` comment and in `README.md`." |

**Good AC checklist patterns:**

```markdown
## Acceptance criteria

- [ ] Given a config with `rateLimits: { "api.github.com": { rps: 5, burst: 10 } }`,
      when 11 requests hit that domain in a single burst, then requests 11+ are blocked
      with an error containing "rate limit exceeded" and the domain name.
- [ ] The `"*"` global fallback key applies to any domain not listed individually.
- [ ] All existing sandbox tests continue to pass (`npm test -- sandbox`).
- [ ] `npx tsc --noEmit` produces no errors.
```

**How ACs relate to the rubric:** ACs are the minimum bar — all must pass. The rubric
scores quality dimensions *beyond* the bar (code elegance, test depth, documentation
thoroughness). When there is no rubric, the judge assesses each AC item directly and
derives a single `ac_satisfaction` score 1–5.

---

## Status lifecycle

```
draft ──► ready ──► in-progress ──► in-review ──► done
                                                 ↘
                                              cancelled
```

| Status | Meaning |
|---|---|
| `draft` | Spec is being written or is not yet actionable. Not dispatched. |
| `ready` | Spec is complete enough to dispatch to agents. |
| `in-progress` | Agents are actively implementing. |
| `in-review` | Champion identified; awaiting human sign-off or `task-finalize`. |
| `done` | Champion branch merged; task complete. |
| `cancelled` | Work stopped; will not be completed. |

### Mapping into `tasks.json`

When `manage_tasks import_backlog` syncs specs into the task board, the 6-state backlog
status maps losslessly into the 4-state `tasks.json` format:

| Backlog status | `tasks.json` status |
|---|---|
| `draft`, `ready` | `queued` |
| `in-progress`, `in-review` | `in-progress` |
| `done` | `done` |
| `cancelled` | `failed` |

The spec's numeric `id` (e.g. `0007`) and the runtime `task-XXXXXX` random ID coexist
losslessly — the filename ID is the human/spec-facing handle; the runtime ID is used
internally by `task-board.ts`.

---

## The product loop

```
PI_BACKLOG_DIR/NNNN-slug.md
       │
       ▼
manage_tasks import_backlog
       │  validates frontmatter → syncs to tasks.json (status + id mapping above)
       ▼
dispatch N implementers in parallel   [workspaceMode: worktree]
  each lands at: <repoRoot>/.worktrees/<agent>-<task-id>/
  reads spec → implements → commits → writes output.md
       │
       ▼  (all implementers done)
orchestrator runs evaluation.automated commands
  ├── gate: true + failure → submission marked "gated", rubric skipped
  └── numeric checks → value + passed recorded in automated results
       │
       ▼
dispatch judge  (tools: read, grep, find, ls — NO bash, NO writes)
  receives task prompt containing:
    - path to spec file (AC + evaluation block are authoritative)
    - JSON manifest, one entry per candidate:
        { agent, branch, worktree_path, output_md_path, automated_results }
  judge: navigates each worktree via read/find/grep
         if gate failed → marks status "gated", skips rubric
         if rubric present → scores each criterion 1–5 with one-sentence justification
         if no rubric → reads ## Acceptance criteria, derives ac_satisfaction score 1–5
         emits one JSON object per candidate → writes to its own output.md
       │
       ▼
orchestrator reads judge output.md
  → appends rows to NNNN-slug.attempts.jsonl   (append-only, durable)
  → rewrites NNNN-slug.eval.json               (ranked + confidence)
       │
       ├── confidence ≥ min_ratio  →  promote champion → status: in-review
       │                               task-finalize → clean PR from merge-base
       │
       └── confidence < min_ratio  →  surface "rerun recommended"
                                       (no auto-dispatch in v1)
           also halts if: attempt_count ≥ max_attempts
                       OR running_cost_usd ≥ max_cost_usd
```

### Confidence scoring

After all submissions are scored, the orchestrator computes a **MAD-based confidence
ratio** to determine whether the champion is a clear winner or just noise:

1. Collect the weighted total scores for all submissions.
2. Compute the **median absolute deviation (MAD)** of those scores.
3. The **confidence score** = `(score_rank1 − score_rank2) / MAD`.
4. If `confidence ≥ min_ratio` (default 2.0), the champion is clear; promote to `in-review`.
5. If `confidence < min_ratio`, surface "rerun recommended" — the gap between the top two
   is within judge noise and another round may produce a different result.

A confidence score of 2.0 means the winner is at least 2× the MAD ahead of the runner-up.
This is the same approach used in pi-autoresearch for scalar metric optimisation.

---

## The judge agent

The judge is a **regular `agent-teams` agent** — a markdown file at
`.pi/agents/judge-default.md` with `tools: read,grep,find,ls` in its frontmatter.
It has **no `bash` access and no write permissions**.

**Key design invariants:**

- **Orchestrator runs automated checks; judge reads the results.** The orchestrator executes
  every `evaluation.automated.cmd` before dispatching the judge. It collects pass/fail and
  numeric results and injects them into the judge's task prompt as a JSON manifest. The judge
  never executes code — this eliminates any write or execution risk from the judge entirely.

- **Judge navigates worktrees via `read`/`find`/`grep`.** Each implementer lands at
  `<repoRoot>/.worktrees/<agent>-<task-id>/`. The orchestrator includes this path in the
  manifest so the judge can inspect any file in any submission.

- **AC fallback.** When `evaluation.rubric` is empty or the `evaluation` block is omitted,
  the judge reads the `## Acceptance criteria` checklist and assesses each item against the
  implementation. It derives a single `ac_satisfaction` score 1–5 per candidate, which is
  recorded in the `rubric` field of the attempts log as `{ "ac_satisfaction": <score> }`.
  This makes simple tasks zero-configuration — just write ACs.

- **Human judge.** Set `judge: "human"` to skip automated judging. The orchestrator surfaces
  the automated results and a rubric template, then waits for manually entered scores before
  appending the row and updating `eval.json`.

- **Swappable profiles.** Judge agent files live in `.pi/agents/` alongside all other
  agents — they are diff-able, reviewable, and versioned in-repo. Use a different judge
  profile for tasks requiring specialised domain knowledge.

Example judge agent file (`.pi/agents/judge-default.md`):

```markdown
---
name: judge-default
description: Scores competing submissions against a backlog task spec
tools: read,grep,find,ls
model: anthropic/claude-sonnet-4-5
---
You are a read-only evaluation agent. The orchestrator dispatches you with a
task prompt containing the spec path and a JSON manifest of every candidate
(agent name, branch, worktree path, output.md path, pre-run automated results).

For each candidate:
1. If any gate: true automated check failed → mark status: gated, skip rubric.
2. Navigate the worktree path using read/find/grep to inspect code and output.md.
3. If the spec has evaluation.rubric entries → score each criterion 1–5 with a
   one-sentence justification. If there are no rubric entries → fall back to
   reading ## Acceptance criteria and deriving a single ac_satisfaction score 1–5.
4. Emit exactly one JSON object per candidate matching the *.attempts.jsonl schema.
   No prose outside the JSON.

You must NOT write or modify any files.
```

Example team configuration (`.pi/agents/teams.yaml` entry):

```yaml
backlog-runner:
  workspaceMode: worktree
  maxConcurrency: 3
  members: [implementer, judge-default]
```

---

## The attempts log (`*.attempts.jsonl`)

One JSON object per line, one line per submission. **Append-only** — rows are never
modified after being written. This gives the same durability guarantee as
`autoresearch.jsonl`: a fresh agent can resume any task from the spec + attempts log alone,
regardless of context loss.

Full per-row schema:

```jsonc
{
  "attempt":      3,                         // Round number (1-based, increments per dispatch round)
  "task_id":      "0007",                    // Matches the spec's id field
  "agent":        "claude-sonnet-A",         // Agent name from .pi/agents/
  "branch":       "task/0007/agent-A",       // Git branch the submission lives on
  "commit":       "abc1234",                 // 7-char short SHA of the submission commit
  "started_at":   "2025-11-12T10:14:00Z",   // ISO 8601, when the agent was dispatched
  "finished_at":  "2025-11-12T10:42:00Z",   // ISO 8601, when the agent wrote output.md
  "automated": {
    "tests":       "pass",                   // Simple gate: "pass" | "fail"
    "types":       "pass",
    "p95_latency": { "value": 42, "passed": true }  // Numeric check with parsed value
  },
  "rubric": {
    "correctness":    5,                     // Judge score 1–5 per criterion id
    "code_quality":   4,
    "test_coverage":  4,
    "api_ergonomics": 3,
    "docs":           3
    // OR, for AC fallback (no rubric in spec):
    // "ac_satisfaction": 4
  },
  "score":    4.15,                          // Weighted total: automated_weight × avg(automated) + rubric_weight × weighted_sum(rubric)
  "status":   "champion",                    // "champion" | "accepted" | "rejected" | "gated"
  "judge":    "claude-judge-default",        // Agent name that produced this row, or "human"
  "notes_path": ".worktrees/run-X-agent-A/output.md"  // Path to the agent's output.md
}
```

**Status values:**

| Status | Meaning |
|---|---|
| `champion` | Highest score in the current eval; candidate for promotion to `in-review`. |
| `accepted` | Passed all gates and was scored, but not the top submission. |
| `rejected` | Scored but ranked below the cutoff (e.g. score too low relative to champion). |
| `gated` | Failed a `gate: true` automated check; rubric scoring was skipped. |

---

## Worked examples

### Example A: Full evaluation block

Frontmatter snippet with gated automated checks and a weighted rubric:

```yaml
evaluation:
  mode: competitive
  workspace: worktree
  budget:
    max_attempts: 3
    max_cost_usd: 50
  automated:
    - id: tests
      cmd: "npm test -- rate-limit"
      gate: true             # non-zero exit → submission is gated, rubric skipped
    - id: types
      cmd: "npx tsc --noEmit"
      gate: true
    - id: p95_latency
      cmd: "node scripts/bench-ratelimit.js"
      parse: "P95_MS=<num>"
      target: "<= 50"        # recorded as passed/failed, but not a gate
  rubric:
    - { id: correctness,  weight: 0.50 }
    - { id: code_quality, weight: 0.30 }
    - { id: docs,         weight: 0.20 }  # weights sum to 1.0
  scoring:
    automated_weight: 0.6
    rubric_weight: 0.4
  judge: claude-judge-default
  confidence:
    enabled: true
    min_ratio: 2.0
```

The judge receives a task prompt containing: the spec path, and a JSON manifest
with each candidate's `agent`, `branch`, `worktree_path`, `output_md_path`, and
`automated_results` (including the `p95_latency` numeric value and whether it
passed the `<= 50` target). The judge navigates each worktree to inspect code,
then scores `correctness`, `code_quality`, and `docs` 1–5 for each non-gated
candidate, and emits one JSON object per candidate.

### Example B: Minimal spec (AC fallback)

No `evaluation` block at all — just the essentials and acceptance criteria:

```yaml
---
id: 0012
title: "Fix sandbox /sandbox command to show session-allowed domains"
status: ready
priority: P2
effort: S
created: 2025-11-20
---

## Acceptance criteria

- [ ] Running `/sandbox` after allowing `api.github.com` shows it under
      "Session-allowed domains".
- [ ] The output format matches the existing `/sandbox` display style.
- [ ] `npm test -- sandbox` passes.
```

Because there is no `evaluation` block (and therefore no rubric), the judge uses
**AC fallback**: it reads the three acceptance criteria items, inspects the candidate's
implementation, and derives a single `ac_satisfaction` score 1–5 for each candidate.
No rubric configuration is needed. The `*.attempts.jsonl` row for this task will have
`"rubric": { "ac_satisfaction": 4 }` (or whatever the judge scores).

---

## Follow-up tooling (not yet implemented)

The following `manage_tasks` actions and skills are **planned but not yet available**.
Until they land, the product loop is orchestrated manually or by the orchestrator
treating the backlog file as the source of truth directly.

**Tracked in `.pi/backlog/0002-backlog-tooling.md`:**

- `manage_tasks import_backlog` — parse `PI_BACKLOG_DIR/*.md` frontmatter into
  `tasks.json` using the status and ID mapping described above.
- `manage_tasks evaluate <id>` — orchestrator runs `evaluation.automated` commands,
  dispatches the judge, appends a row to `*.attempts.jsonl`, rewrites `*.eval.json`,
  and checks budget caps before each dispatch.
- `manage_tasks rank <id>` — re-reads `*.attempts.jsonl`, recomputes confidence, returns
  the current ranked list.
- `manage_tasks finalize <id>` — promotes the champion branch to a clean PR from
  merge-base.
- Frontmatter schema validation via typebox (same pattern as `extensions/todos.ts` tool
  params).
- Append-only atomic writer for `*.attempts.jsonl` (same durability pattern as
  `task-board.ts`).

**Tracked in `.pi/backlog/0003-backlog-skills.md`:**

- `task-create` — interactive author interview → writes `NNNN-slug.md`. Registers as the
  `/backlog-new` slash command.
- `task-implement` — loaded by competing agents; reads spec from `PI_BACKLOG_DIR`, works
  in worktree, writes `output.md`, commits.
- `task-judge` — loaded by the judge agent; scoring contract, rubric schema, AC-fallback
  logic, output format.
- `task-finalize` — champion branch → clean independent PR branches from merge-base,
  mirroring `autoresearch-finalize`.

---

## Directory layout reference

```
PI_BACKLOG_DIR/          # default: .pi/backlog/ ; override: PI_BACKLOG_DIR env var
  TEMPLATE.md            # copy-pasteable starter (see Quick start)
  0001-example-task.md   # fully-filled reference spec
  NNNN-slug.md           # your spec — the single source of truth
  NNNN-slug.attempts.jsonl  # append-only, one JSON row per submission
  NNNN-slug.eval.json       # latest ranked results + confidence (regenerable)
```

The default `.pi/backlog/` is gitignored like other `.pi/` runtime state. To version
specs in-repo (recommended for team projects), set `PI_BACKLOG_DIR=backlog` (or any
repo-root path) and un-ignore that directory.
