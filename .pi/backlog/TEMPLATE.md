<!-- TEMPLATE — copy this file, rename it NNNN-your-slug.md, and fill in every field.
     Full field reference and author guide: docs/agent-task-spec.md -->
---
id: NNNN
title: ""
status: draft        # draft | ready | in-progress | in-review | done | cancelled
priority: P2         # P0 must | P1 should | P2 nice | P3 someday
effort: M            # XS | S | M | L | XL
created: YYYY-MM-DD
owner: ""            # github handle or name of the human author
assignees: []        # agent ids once dispatched (filled by orchestrator)
depends_on: []       # list of task ids that must be done first
tags: []

# How this task is evaluated when multiple agents submit competing work.
# This block is the "autoresearch.sh + scoring" of the product loop.
evaluation:
  mode: competitive  # solo | coordinated | competitive
  workspace: worktree
  budget:
    max_attempts: 3    # max rounds before stopping (whichever limit hits first)
    max_cost_usd: 50   # cumulative $ cap across all attempts and sessions
  automated: []        # optional — list of {id, cmd, gate?, parse?, target?}
  rubric: []           # optional — omit or leave empty to use AC fallback
  scoring:
    automated_weight: 0.6
    rubric_weight: 0.4
  judge: claude-judge-default  # agent name from .pi/agents/, or "human"
  confidence:
    enabled: true
    min_ratio: 2.0     # winner must be ≥ 2× MAD ahead of runner-up
---

## Why

*One sentence: the problem, who feels it, what changes when this ships.*

## What (scope)

- *Bullet 1 — user-visible behaviour being added or changed*
- *Bullet 2 — ...*

## Out of scope

- *Non-goal 1 — pins the blast radius for agents*
- *Non-goal 2 — ...*

## Acceptance criteria

- [ ] *Given … when … then … (G/W/T encouraged but not required)*
- [ ] *...*

## Success metrics (post-ship)

*How we'll know it worked in production — leading/lagging indicators (e.g. error rate, latency p95, adoption count).*

## Failure modes / risks

*What could go wrong, what we accept, what we won't tolerate.*

## Notes / hints

*(Optional) Pointers to relevant files, prior art, libraries to prefer or avoid.*
