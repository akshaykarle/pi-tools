// Todos — standalone task board extension.
//
// Provides the manage_tasks tool for tracking todo lists on the filesystem.
// By default stores tasks in .pi/todos/tasks.json relative to the current
// working directory. Override with:
//   - PI_TODO_PATH env var (directory path)
//   - setActiveTodosDir(dir) exported function (used programmatically by agent-teams)
//
// Backlog directory (for import_backlog / evaluate / rank / finalize):
//   - PI_BACKLOG_DIR env var (directory path)
//   - setActiveBacklogDir(dir) exported function
//   Default: .pi/backlog/ relative to cwd.
//
// Usage: pi -e extensions/todos.ts

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  addTask,
  addTasks,
  getTask,
  listTasks,
  updateTask,
  type Task,
  type TaskStatus,
} from "./todos/task-board.js";
import {
  parseSpecFile,
  mapStatusToTaskStatus,
  normaliseSpecId,
  type BacklogSpec,
} from "./todos/backlog-parser.js";
import {
  appendAttemptRow,
  readAttemptRows,
  type AttemptRow,
} from "./todos/attempts-writer.js";
import {
  checkBudget,
  buildBudgetState,
  buildEvalJson,
  computeConfidence,
  writeEvalJson,
} from "./todos/eval-engine.js";

// Re-export types and functions for use by other extensions (e.g. agent-teams).
export type { Task, TaskStatus };
export { addTask, addTasks, getTask, listTasks, updateTask };

// ── Active directory state ────────────────────────────────────────────────────
// Module-level override for the todos directory. When set, takes priority over
// the PI_TODO_PATH env var and the default .pi/todos/ path. Used by agent-teams
// to redirect manage_tasks calls to the run workspace.

let _activeTodosDir: string | null = null;

/** Override the todos directory for this session. Call resetActiveTodosDir() to restore defaults. */
export function setActiveTodosDir(dir: string): void {
  _activeTodosDir = dir;
}

/** Clear the directory override; future calls will use PI_TODO_PATH or .pi/todos/. */
export function resetActiveTodosDir(): void {
  _activeTodosDir = null;
}

/** Resolve the active todos directory at call-time. */
function resolveActiveTodosDir(cwd: string): string {
  if (_activeTodosDir !== null) return _activeTodosDir;
  if (process.env.PI_TODO_PATH) return process.env.PI_TODO_PATH;
  return join(cwd, ".pi", "todos");
}

// ── Backlog directory state ───────────────────────────────────────────────────
// Three-level precedence (same pattern as todos):
//   1. setActiveBacklogDir() programmatic override (used by tests / agent-teams)
//   2. PI_BACKLOG_DIR env var
//   3. <cwd>/.pi/backlog/ default

let _activeBacklogDir: string | null = null;

/** Override the backlog directory for this session. */
export function setActiveBacklogDir(dir: string): void {
  _activeBacklogDir = dir;
}

/** Clear the backlog directory override. */
export function resetActiveBacklogDir(): void {
  _activeBacklogDir = null;
}

/** Resolve the active backlog directory at call-time. */
export function getBacklogDir(cwd: string): string {
  if (_activeBacklogDir !== null) return _activeBacklogDir;
  if (process.env.PI_BACKLOG_DIR) return process.env.PI_BACKLOG_DIR;
  return join(cwd, ".pi", "backlog");
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "manage_tasks",
    label: "Manage Tasks",
    description:
      "Manage the shared task board: add, update, list, or get tasks. Use 'add_batch' to create multiple tasks at once with dependency ordering.",
    promptSnippet:
      "manage_tasks — Add, update, list, or get tasks on the shared task board.",
    promptGuidelines: [
      "Always create tasks before starting work on them.",
      "Use dependencies to express ordering between tasks.",
      "Update task status as work progresses.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("add_batch"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("get"),
          Type.Literal("import_backlog"),
          Type.Literal("evaluate"),
          Type.Literal("rank"),
          Type.Literal("finalize"),
        ],
        { description: "Action to perform" },
      ),
      title: Type.Optional(Type.String({ description: "Task title (for 'add')" })),
      description: Type.Optional(Type.String({ description: "Task description (for 'add')" })),
      dependencies: Type.Optional(
        Type.Array(Type.String(), {
          description: "Task IDs this task depends on (for 'add')",
        }),
      ),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String(),
            description: Type.String(),
            dependencies: Type.Optional(Type.Array(Type.String())),
          }),
          { description: "Batch of tasks to add (for 'add_batch')" },
        ),
      ),
      taskId: Type.Optional(Type.String({ description: "Task ID (for 'update'/'get')" })),
      status: Type.Optional(Type.String({ description: "New status (for 'update')" })),
      result: Type.Optional(Type.String({ description: "Result summary (for 'update')" })),
    }),
    // @ts-ignore
    
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as Record<string, unknown>;
      const context = ctx as any;
      const dir = resolveActiveTodosDir(context.cwd);

      switch (p.action) {
        case "add": {
          if (!p.title || !p.description) {
            return {
              content: [
                { type: "text", text: "Missing title or description for 'add' action." },
              ],
            };
          }
          const task = addTask(dir, {
            title: p.title as string,
            description: p.description as string,
            dependencies: (p.dependencies as string[]) ?? [],
          });
          return {
            content: [
              {
                type: "text",
                text: `Task created: ${task.id} — ${task.title}`,
              },
            ],
            details: task,
          };
        }

        case "add_batch": {
          const items = p.tasks as Array<{
            title: string;
            description: string;
            dependencies?: string[];
          }>;
          if (!items || items.length === 0) {
            return {
              content: [{ type: "text", text: "No tasks provided for 'add_batch'." }],
            };
          }
          const created = addTasks(dir, items);
          const summary = created
            .map((t) => `  ${t.id}: ${t.title}`)
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text: `Created ${created.length} task(s):\n${summary}`,
              },
            ],
            details: created,
          };
        }

        case "update": {
          if (!p.taskId) {
            return {
              content: [{ type: "text", text: "Missing taskId for 'update' action." }],
            };
          }
          const updated = updateTask(dir, p.taskId as string, {
            status: p.status as "queued" | "in-progress" | "done" | "failed" | undefined,
            result: p.result as string | undefined,
          });
          if (!updated) {
            return {
              content: [
                { type: "text", text: `Task ${p.taskId} not found.` },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Task ${updated.id} updated: ${updated.status}`,
              },
            ],
            details: updated,
          };
        }

        case "list": {
          const tasks = listTasks(dir);
          if (tasks.length === 0) {
            return {
              content: [{ type: "text", text: "No tasks on the board yet." }],
            };
          }
          const lines = tasks.map((t) => {
            const status = t.status === "done" ? "✅" : t.status === "failed" ? "❌" : t.status === "in-progress" ? "🔄" : "⏳";
            const assignee = t.assignee ? ` (${t.assignee})` : "";
            const deps = t.dependencies.length > 0 ? ` [deps: ${t.dependencies.join(", ")}]` : "";
            return `${status} ${t.id}: ${t.title}${assignee}${deps}`;
          });
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: tasks,
          };
        }

        case "get": {
          if (!p.taskId) {
            return {
              content: [{ type: "text", text: "Missing taskId for 'get' action." }],
            };
          }
          const task = getTask(dir, p.taskId as string);
          if (!task) {
            return {
              content: [{ type: "text", text: `Task ${p.taskId} not found.` }],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `${task.id}: ${task.title}\nStatus: ${task.status}\nAssignee: ${task.assignee || "none"}\nDescription: ${task.description}\nResult: ${task.result || "(none)"}`,
              },
            ],
            details: task,
          };
        }

        // ── import_backlog ──────────────────────────────────────────────────
        case "import_backlog": {
          const backlogDir = getBacklogDir(context.cwd);
          if (!existsSync(backlogDir)) {
            return {
              content: [{ type: "text", text: `Backlog directory not found: ${backlogDir}` }],
            };
          }

          const files = readdirSync(backlogDir)
            .filter((f) => /^\d{4}-[\w-]+\.md$/.test(f))
            .sort();

          if (files.length === 0) {
            return {
              content: [{ type: "text", text: `No spec files found in ${backlogDir}` }],
            };
          }

          const existing = listTasks(dir);
          // Build a lookup: backlog_id → task
          const byBacklogId = new Map<string, Task>();
          for (const t of existing) {
            const bid = (t as Task & { backlog_id?: string }).backlog_id;
            if (bid) byBacklogId.set(bid, t);
          }

          const imported: string[] = [];
          const skipped: string[] = [];

          for (const file of files) {
            const filePath = join(backlogDir, file);
            const spec = parseSpecFile(filePath);
            if (!spec) {
              skipped.push(file);
              continue;
            }

            const specId = normaliseSpecId(spec.id);
            const taskStatus = mapStatusToTaskStatus(spec.status);
            const description = `Backlog spec: ${filePath}\nPriority: ${spec.priority ?? "—"} | Effort: ${spec.effort ?? "—"}\nDepends on: ${(spec.depends_on ?? []).join(", ") || "none"}\nTags: ${(spec.tags ?? []).join(", ") || "none"}`;

            const existing = byBacklogId.get(specId);
            if (existing) {
              // Update the existing task — preserve its runtime ID and createdAt.
              updateTask(dir, existing.id, {
                status: taskStatus,
              });
              imported.push(`updated ${existing.id} ← ${file}`);
            } else {
              // Create a new task and write backlog_id back.
              const created = addTask(dir, {
                title: spec.title,
                description,
                dependencies: [],
              });
              // Patch backlog_id onto the stored task.
              const tasks = listTasks(dir);
              const idx = tasks.findIndex((t) => t.id === created.id);
              if (idx !== -1) {
                (tasks[idx] as Task & { backlog_id?: string }).backlog_id = specId;
                // Re-set status (addTask always creates as "queued").
                tasks[idx].status = taskStatus;
                tasks[idx].updatedAt = new Date().toISOString();
                // Atomically overwrite.
                const { join: pathJoin } = await import("node:path");
                const { renameSync, writeFileSync, mkdirSync } = await import("node:fs");
                const { randomBytes } = await import("node:crypto");
                const tasksFile = pathJoin(dir, "tasks.json");
                mkdirSync(dir, { recursive: true });
                const tmp = `${tasksFile}.tmp.${randomBytes(4).toString("hex")}`;
                writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf-8");
                renameSync(tmp, tasksFile);
              }
              imported.push(`created ${created.id} ← ${file}`);
            }
          }

          const lines = [
            `Imported ${imported.length} spec(s) from ${backlogDir}:`,
            ...imported.map((s) => `  ✅ ${s}`),
            ...(skipped.length > 0 ? [`Skipped ${skipped.length} file(s) (parse errors):`] : []),
            ...skipped.map((s) => `  ⚠️  ${s}`),
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // ── evaluate ───────────────────────────────────────────────────────
        case "evaluate": {
          // evaluate returns a budget-check result and the current eval state.
          // It does NOT dispatch agents — that is the orchestrator's job.
          // The orchestrator calls evaluate before dispatching a new round to
          // check whether caps have been reached.
          const taskId = p.taskId as string | undefined;
          if (!taskId) {
            return { content: [{ type: "text", text: "Missing taskId for 'evaluate' action." }] };
          }

          const backlogDir = getBacklogDir(context.cwd);
          // Find the spec file.
          const specFiles = existsSync(backlogDir)
            ? readdirSync(backlogDir).filter((f) => f.startsWith(taskId) && f.endsWith(".md"))
            : [];

          if (specFiles.length === 0) {
            return {
              content: [{ type: "text", text: `No spec file found for task id "${taskId}" in ${backlogDir}` }],
            };
          }

          const specFile = join(backlogDir, specFiles[0]);
          const spec = parseSpecFile(specFile);
          if (!spec) {
            return {
              content: [{ type: "text", text: `Failed to parse spec: ${specFile}` }],
            };
          }

          const jsonlPath = join(backlogDir, `${taskId}-${specFiles[0].replace(/^\d+-/, "").replace(/\.md$/, "")}.attempts.jsonl`);
          const rows = readAttemptRows(jsonlPath);
          const budgetCheck = checkBudget(rows, spec);

          if (budgetCheck.halted) {
            return {
              content: [
                {
                  type: "text",
                  text: `⛔ Evaluation halted: ${budgetCheck.reason}\nNo new round dispatched.`,
                },
              ],
              details: { halted: true, reason: budgetCheck.reason, rows: rows.length },
            };
          }

          const budgetState = buildBudgetState(rows, spec);
          const minRatio = spec.evaluation?.confidence?.min_ratio ?? 2.0;
          const evalJson = buildEvalJson(normaliseSpecId(spec.id), rows, budgetState, minRatio);

          return {
            content: [
              {
                type: "text",
                text: [
                  `Task ${normaliseSpecId(spec.id)}: ${spec.title}`,
                  `Attempts so far: ${rows.length} / ${budgetState.maxAttempts ?? "∞"}`,
                  `Cost so far: $${budgetState.costUsdUsed.toFixed(2)} / $${budgetState.maxCostUsd ?? "∞"}`,
                  `Confidence: ${evalJson.confidence.score} (threshold: ${minRatio}) — ${
                    evalJson.confidence.aboveThreshold ? "✅ above" : "⚠️  below"
                  }`,
                  `Recommendation: ${evalJson.recommendation}`,
                  `Budget check: ✅ clear — ready to dispatch next round`,
                ].join("\n"),
              },
            ],
            details: evalJson,
          };
        }

        // ── rank ────────────────────────────────────────────────────────────
        case "rank": {
          const taskId = p.taskId as string | undefined;
          if (!taskId) {
            return { content: [{ type: "text", text: "Missing taskId for 'rank' action." }] };
          }

          const backlogDir = getBacklogDir(context.cwd);
          const jsonlFiles = existsSync(backlogDir)
            ? readdirSync(backlogDir).filter(
                (f) => f.startsWith(taskId) && f.endsWith(".attempts.jsonl"),
              )
            : [];

          if (jsonlFiles.length === 0) {
            return {
              content: [{ type: "text", text: `No attempts log found for task "${taskId}".` }],
            };
          }

          const jsonlPath = join(backlogDir, jsonlFiles[0]);
          const rows = readAttemptRows(jsonlPath);

          if (rows.length === 0) {
            return { content: [{ type: "text", text: "No attempt rows found." }] };
          }

          const sorted = [...rows].sort((a, b) => b.score - a.score);
          const minRatio = 2.0;
          const confidence = computeConfidence(sorted.map((r) => r.score), minRatio);

          const lines = [
            `Rankings for task ${taskId} (${rows.length} submission${rows.length === 1 ? "" : "s"}):`,
            ...sorted.map(
              (r, i) =>
                `  ${i + 1}. ${r.agent} — score: ${r.score} [${r.status}] branch: ${r.branch}`,
            ),
            `Confidence: ${confidence.score} (min_ratio: ${minRatio}) — ${
              confidence.aboveThreshold ? "✅ above threshold" : "⚠️  below threshold"
            }`,
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { rows: sorted, confidence },
          };
        }

        // ── finalize ────────────────────────────────────────────────────────
        case "finalize": {
          const taskId = p.taskId as string | undefined;
          if (!taskId) {
            return { content: [{ type: "text", text: "Missing taskId for 'finalize' action." }] };
          }

          const backlogDir = getBacklogDir(context.cwd);
          const evalFiles = existsSync(backlogDir)
            ? readdirSync(backlogDir).filter(
                (f) => f.startsWith(taskId) && f.endsWith(".eval.json"),
              )
            : [];

          if (evalFiles.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No eval.json found for task "${taskId}". Run 'evaluate' first.`,
                },
              ],
            };
          }

          const { readFileSync } = await import("node:fs");
          let evalJson: ReturnType<typeof buildEvalJson>;
          try {
            evalJson = JSON.parse(readFileSync(join(backlogDir, evalFiles[0]), "utf-8"));
          } catch {
            return { content: [{ type: "text", text: `Failed to read ${evalFiles[0]}` }] };
          }

          const champion = evalJson.ranking?.[0];
          if (!champion || champion.status !== "champion") {
            return {
              content: [
                {
                  type: "text",
                  text: [
                    `No champion identified for task ${taskId} yet.`,
                    evalJson.recommendation
                      ? `Recommendation: ${evalJson.recommendation}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join("\n"),
                },
              ],
            };
          }

          // Return a finalize manifest for the orchestrator / task-finalize skill.
          return {
            content: [
              {
                type: "text",
                text: [
                  `Champion identified for task ${taskId}:`,
                  `  Agent:  ${champion.agent}`,
                  `  Branch: ${champion.branch}`,
                  `  Score:  ${champion.score}`,
                  ``,
                  `To finalize, load the task-finalize skill and execute:`,
                  `  1. Create branch task/${taskId}/final from merge-base`,
                  `  2. Rebase ${champion.branch} onto task/${taskId}/final`,
                  `  3. Update spec status to in-review`,
                  `  4. Write PR description to output.md`,
                ].join("\n"),
              },
            ],
            details: { champion, task_id: taskId },
          };
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown action "${p.action}". Use: add, add_batch, update, list, get, import_backlog, evaluate, rank, finalize.`,
              },
            ],
          };
      }
    },
  });
}
