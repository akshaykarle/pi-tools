// Agent Teams — filesystem-backed shared task board.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Task, TaskStatus } from "./types.js";

function tasksFilePath(runDirPath: string): string {
  return join(runDirPath, "tasks.json");
}

/** Generate a unique task ID. */
function generateTaskId(): string {
  const rand = randomBytes(3).toString("hex");
  return `task-${rand}`;
}

/**
 * Atomically write JSON to a file (write to temp, then rename).
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Load all tasks for a run. Returns empty array if file doesn't exist.
 */
export function listTasks(runDirPath: string): Task[] {
  const filePath = tasksFilePath(runDirPath);
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Task[];
  } catch {
    return [];
  }
}

/**
 * Get a single task by ID. Returns null if not found.
 */
export function getTask(runDirPath: string, taskId: string): Task | null {
  const tasks = listTasks(runDirPath);
  return tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * Add a new task to the board and return it.
 */
export function addTask(
  runDirPath: string,
  opts: {
    title: string;
    description: string;
    dependencies?: string[];
  },
): Task {
  const tasks = listTasks(runDirPath);

  const now = new Date().toISOString();
  const task: Task = {
    id: generateTaskId(),
    title: opts.title,
    description: opts.description,
    status: "queued",
    assignee: "",
    dependencies: opts.dependencies ?? [],
    result: "",
    createdAt: now,
    updatedAt: now,
  };

  tasks.push(task);
  atomicWriteJson(tasksFilePath(runDirPath), tasks);
  return task;
}

/**
 * Update fields on an existing task.
 * Returns the updated task, or null if not found.
 */
export function updateTask(
  runDirPath: string,
  taskId: string,
  updates: {
    status?: TaskStatus;
    assignee?: string;
    result?: string;
  },
): Task | null {
  const tasks = listTasks(runDirPath);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;

  const task = tasks[idx];
  if (updates.status !== undefined) task.status = updates.status;
  if (updates.assignee !== undefined) task.assignee = updates.assignee;
  if (updates.result !== undefined) task.result = updates.result;
  task.updatedAt = new Date().toISOString();

  tasks[idx] = task;
  atomicWriteJson(tasksFilePath(runDirPath), tasks);
  return task;
}

/**
 * Bulk-add multiple tasks at once. Returns the created tasks.
 */
export function addTasks(
  runDirPath: string,
  items: Array<{
    title: string;
    description: string;
    dependencies?: string[];
  }>,
): Task[] {
  const tasks = listTasks(runDirPath);
  const created: Task[] = [];

  const now = new Date().toISOString();
  for (const item of items) {
    const task: Task = {
      id: generateTaskId(),
      title: item.title,
      description: item.description,
      status: "queued",
      assignee: "",
      dependencies: item.dependencies ?? [],
      result: "",
      createdAt: now,
      updatedAt: now,
    };
    tasks.push(task);
    created.push(task);
  }

  atomicWriteJson(tasksFilePath(runDirPath), tasks);
  return created;
}
