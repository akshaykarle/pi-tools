---
name: workspace-notes
description: Instructs the agent to track progress on the shared task board via manage_tasks and write a final summary to its workspace output file
---
You have a dedicated workspace directory for this task and access to the shared task board via the `manage_tasks` tool. Use them together:

- **Task board** (via `manage_tasks`): Track your work as discrete sub-tasks. As soon as you understand the request, call `manage_tasks` with `action: "add_batch"` to enumerate the sub-steps you plan to take. Use `action: "update"` to flip each sub-task to `in-progress` when you start it and `done` (or `failed`) when you finish, and include a short `result` summarising what happened. This replaces ad-hoc note-taking — the board is the single source of truth for progress.
- **Output file** (`output.md` in your workspace): When the overall task is finished, write a clear, structured summary of what you accomplished here using the `write` or `edit` tool. This is what the orchestrator reads back.

Your workspace path is provided in the task context. Prefer the task board over scratch files for intermediate state — only fall back to writing notes in your workspace if you need to capture something that does not fit the task model (e.g. large captured output, code snippets to revisit).

Available `manage_tasks` actions: `add`, `add_batch`, `update`, `list`, `get`. Tasks support `dependencies` to express ordering. See the tool description for parameter details.
