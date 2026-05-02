import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectIncompleteRuns,
  formatIncompleteRunsSummary,
} from "./crash-recovery.js";
import type { RunState, Task } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "crash-recovery-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeRun(teamName: string, runId: string, run: RunState, tasks: Task[]) {
  const dir = join(tmpDir, ".pi", "agent-teams", "runs", teamName, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify(run), "utf-8");
  writeFileSync(join(dir, "tasks.json"), JSON.stringify(tasks), "utf-8");
}

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "run-1",
    team: "team-a",
    goal: "Build feature",
    status: "running",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task 1",
    description: "Desc",
    status: "queued",
    assignee: "",
    dependencies: [],
    result: "",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("detectIncompleteRuns", () => {
  it("detects runs with in-progress tasks", () => {
    writeRun("team-a", "run-1", makeRun(), [
      makeTask({ id: "t1", status: "done" }),
      makeTask({ id: "t2", status: "in-progress", assignee: "researcher" }),
      makeTask({ id: "t3", status: "queued" }),
    ]);

    const results = detectIncompleteRuns(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].interruptedTasks).toHaveLength(1);
    expect(results[0].interruptedTasks[0].id).toBe("t2");
    expect(results[0].completedTasks).toHaveLength(1);
    expect(results[0].queuedTasks).toHaveLength(1);
  });

  it("ignores completed runs", () => {
    writeRun("team-a", "run-2", makeRun({ status: "completed", runId: "run-2" }), [
      makeTask({ status: "done" }),
    ]);

    const results = detectIncompleteRuns(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("detects runs with only queued tasks", () => {
    writeRun("team-a", "run-3", makeRun({ runId: "run-3" }), [
      makeTask({ id: "t1", status: "queued" }),
    ]);

    const results = detectIncompleteRuns(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].queuedTasks).toHaveLength(1);
  });

  it("returns empty when no runs directory exists", () => {
    expect(detectIncompleteRuns(tmpDir)).toEqual([]);
  });

  it("scans across multiple teams", () => {
    writeRun("team-a", "run-a", makeRun({ runId: "run-a", team: "team-a" }), [
      makeTask({ id: "t1", status: "in-progress" }),
    ]);
    writeRun("team-b", "run-b", makeRun({ runId: "run-b", team: "team-b" }), [
      makeTask({ id: "t2", status: "queued" }),
    ]);

    const results = detectIncompleteRuns(tmpDir);
    expect(results).toHaveLength(2);
  });
});

describe("formatIncompleteRunsSummary", () => {
  it("formats a summary", () => {
    const summary = formatIncompleteRunsSummary([
      {
        run: makeRun(),
        interruptedTasks: [makeTask({ id: "t1", title: "Research", assignee: "researcher", status: "in-progress" })],
        completedTasks: [],
        queuedTasks: [makeTask({ id: "t2", title: "Implement", status: "queued" })],
      },
    ]);

    expect(summary).toContain("1 incomplete run(s)");
    expect(summary).toContain("run-1");
    expect(summary).toContain("Build feature");
    expect(summary).toContain("1 interrupted");
    expect(summary).toContain("Research");
  });

  it("returns message for no incomplete runs", () => {
    expect(formatIncompleteRunsSummary([])).toBe("No incomplete runs found.");
  });
});
