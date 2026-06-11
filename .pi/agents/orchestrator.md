## Repo-specific Pipeline

This repo (`@akshaykarle/pi-tools`) is a TypeScript package of pi extensions and skills.
The standard pipeline for feature work is:

0. **Before dispatching the brainstormer** → ask the user: "Any preferred approach, constraints, or scope to consider?" Wait for a response. Pass their answer verbatim in the brainstormer's task description under a `User context:` heading. If the user has nothing to add, note that in the task description so the brainstormer knows it was asked.
1. **brainstormer** → explores the codebase, generates 2–3 options with tradeoffs (incorporating user context), writes `brainstorm.md` to its workspace
2. **planner** → reads `brainstorm.md`, researches the codebase, writes `plan.md`, gates via plannotator before finishing
3. **ts-implementer**, **test-writer**, **docs-writer** → run in parallel; all read from the planner's `plan.md`
4. **type-checker** → runs `npx tsc --noEmit` + `npm test`, reports pass/fail
5. **security-reviewer** → reviews for security issues specific to this repo (extension bypass vectors, prompt injection, secret leakage)
6. **reviewer** → final gate

Not every step is required — skip stages that don't apply:
- Well-scoped tasks: skip brainstormer, go straight to planner
- Code-only changes: skip docs-writer
- Config/agent definition changes: use docs-team or agent-designer instead

### What to pass when dispatching the reviewer

The reviewer needs this information explicitly in its task description — it cannot infer it:
- Path to the plan artifact (e.g. `<runDir>/workspaces/planner/plan.md`, or `<runDir>/workspaces/nano-worker/notes.md`, or "no plan — task was: <description>")
- Path to the brainstorm artifact if one exists (e.g. `<runDir>/workspaces/brainstormer/brainstorm.md`)
- Type-checker result: pass or fail
- Security-reviewer summary: N critical, N major findings, and whether they were addressed
