// Todos — standalone task board extension.
//
// Provides the manage_tasks tool for tracking todo lists on the filesystem.
// By default stores tasks in .pi/todos/tasks.json relative to the current
// working directory. Override with:
//   - PI_TODO_PATH env var (directory path)
//   - setActiveTodosDir(dir) exported function (used programmatically by agent-teams)
//
// Usage: pi -e extensions/todos.ts

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown action "${p.action}". Use: add, add_batch, update, list, get.`,
              },
            ],
          };
      }
    },
  });
}
