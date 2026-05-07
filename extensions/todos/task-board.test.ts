import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTask, addTasks, getTask, listTasks, updateTask } from "./task-board.js";

let runDirPath: string;

beforeEach(() => {
  runDirPath = mkdtempSync(join(tmpdir(), "task-board-test-"));
  mkdirSync(runDirPath, { recursive: true });
});

afterEach(() => {
  rmSync(runDirPath, { recursive: true, force: true });
});

describe("addTask", () => {
  it("creates a task with defaults", () => {
    const task = addTask(runDirPath, {
      title: "Research API",
      description: "Find all auth patterns",
    });

    expect(task.id).toMatch(/^task-[a-f0-9]+$/);
    expect(task.title).toBe("Research API");
    expect(task.status).toBe("queued");
    expect(task.assignee).toBe("");
    expect(task.dependencies).toEqual([]);
  });

  it("persists to disk", () => {
    addTask(runDirPath, { title: "Task 1", description: "Desc 1" });
    addTask(runDirPath, { title: "Task 2", description: "Desc 2" });

    const tasks = listTasks(runDirPath);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("Task 1");
    expect(tasks[1].title).toBe("Task 2");
  });
});

describe("addTasks", () => {
  it("bulk-adds multiple tasks", () => {
    const created = addTasks(runDirPath, [
      { title: "A", description: "A desc" },
      { title: "B", description: "B desc", dependencies: [] },
    ]);

    expect(created).toHaveLength(2);
    expect(listTasks(runDirPath)).toHaveLength(2);
  });
});

describe("getTask", () => {
  it("returns a specific task", () => {
    const task = addTask(runDirPath, { title: "Find me", description: "Test" });
    const found = getTask(runDirPath, task.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Find me");
  });

  it("returns null for unknown ID", () => {
    expect(getTask(runDirPath, "task-nonexistent")).toBeNull();
  });
});

describe("updateTask", () => {
  it("updates status and assignee", () => {
    const task = addTask(runDirPath, { title: "Task", description: "Desc" });
    const updated = updateTask(runDirPath, task.id, {
      status: "in-progress",
      assignee: "researcher",
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("in-progress");
    expect(updated!.assignee).toBe("researcher");

    // Verify persisted
    const reloaded = getTask(runDirPath, task.id);
    expect(reloaded!.status).toBe("in-progress");
  });

  it("updates result", () => {
    const task = addTask(runDirPath, { title: "Task", description: "Desc" });
    updateTask(runDirPath, task.id, {
      status: "done",
      result: "Found 3 patterns",
    });

    const reloaded = getTask(runDirPath, task.id);
    expect(reloaded!.result).toBe("Found 3 patterns");
  });

  it("returns null for unknown task", () => {
    expect(updateTask(runDirPath, "nope", { status: "done" })).toBeNull();
  });
});

describe("listTasks", () => {
  it("returns empty array when file does not exist", () => {
    expect(listTasks(runDirPath)).toEqual([]);
  });
});
