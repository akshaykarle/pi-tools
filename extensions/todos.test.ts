// Tests for the todos.ts extension entry point.
//
// Strategy: register the extension against a mock API, capture the
// `manage_tasks` tool handler, then invoke it directly with a temporary
// filesystem directory. Assertions are on return-value text content and
// on-disk state — not on mock call counts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockApi, makeCtx } from "./__tests__/test-utils.js";

// Mock eval-engine's execSync so no real commands run.
const execSyncMock = vi.hoisted(() => vi.fn(() => ""));
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

import todosFactory, {
  setActiveTodosDir,
  resetActiveTodosDir,
  setActiveBacklogDir,
  resetActiveBacklogDir,
} from "./todos.js";

// ── helpers ───────────────────────────────────────────────────────────────────

type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;

let tmpDir: string;
let execute: ToolExecute;
let ctx: ReturnType<typeof makeCtx>;

function setup() {
  const mock = makeMockApi();
  todosFactory(mock.api as unknown as Parameters<typeof todosFactory>[0]);

  const toolCall = mock.api.registerTool.mock.calls.find(
    (c: unknown[]) => (c[0] as { name: string }).name === "manage_tasks",
  );
  expect(toolCall).toBeDefined();
  return (toolCall![0] as { execute: ToolExecute }).execute;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "todos-test-"));
  setActiveTodosDir(tmpDir);
  ctx = makeCtx({ cwd: tmpDir });
  execute = setup();
  execSyncMock.mockReset();
});

afterEach(() => {
  resetActiveTodosDir();
  resetActiveBacklogDir();
  rmSync(tmpDir, { recursive: true, force: true });
});

function call(params: Record<string, unknown>) {
  return execute("call-id", params, undefined, undefined, ctx);
}

// ── action: add ───────────────────────────────────────────────────────────────

describe("action: add", () => {
  it("creates a task and returns its id and title", async () => {
    const result = await call({ action: "add", title: "My task", description: "Do the thing" });
    expect(result.content[0].text).toContain("Task created");
    expect(result.content[0].text).toContain("My task");
  });

  it("returns error text when title is missing", async () => {
    const result = await call({ action: "add", description: "no title" });
    expect(result.content[0].text).toContain("Missing title");
  });

  it("returns error text when description is missing", async () => {
    const result = await call({ action: "add", title: "x" });
    expect(result.content[0].text).toContain("Missing");
  });

  it("details property contains the task object", async () => {
    const result = await call({ action: "add", title: "T", description: "D" });
    const details = result.details as { title: string; id: string };
    expect(details.title).toBe("T");
    expect(details.id).toMatch(/^task-/);
  });
});

// ── action: add_batch ─────────────────────────────────────────────────────────

describe("action: add_batch", () => {
  it("creates multiple tasks and reports count", async () => {
    const result = await call({
      action: "add_batch",
      tasks: [
        { title: "Task A", description: "Desc A" },
        { title: "Task B", description: "Desc B" },
      ],
    });
    expect(result.content[0].text).toContain("Created 2 task(s)");
    expect(result.content[0].text).toContain("Task A");
    expect(result.content[0].text).toContain("Task B");
  });

  it("returns error text when tasks array is empty", async () => {
    const result = await call({ action: "add_batch", tasks: [] });
    expect(result.content[0].text).toContain("No tasks");
  });

  it("returns error text when tasks is absent", async () => {
    const result = await call({ action: "add_batch" });
    expect(result.content[0].text).toContain("No tasks");
  });

  it("details contains the array of created tasks", async () => {
    const result = await call({
      action: "add_batch",
      tasks: [{ title: "Alpha", description: "d" }],
    });
    const details = result.details as Array<{ title: string }>;
    expect(Array.isArray(details)).toBe(true);
    expect(details[0].title).toBe("Alpha");
  });
});

// ── action: list ──────────────────────────────────────────────────────────────

describe("action: list", () => {
  it("returns 'No tasks' when board is empty", async () => {
    const result = await call({ action: "list" });
    expect(result.content[0].text).toContain("No tasks");
  });

  it("lists tasks after they are added", async () => {
    await call({ action: "add", title: "First", description: "d" });
    await call({ action: "add", title: "Second", description: "d" });
    const result = await call({ action: "list" });
    expect(result.content[0].text).toContain("First");
    expect(result.content[0].text).toContain("Second");
  });

  it("shows done emoji for done tasks", async () => {
    const added = await call({ action: "add", title: "Done task", description: "d" });
    const task = added.details as { id: string };
    await call({ action: "update", taskId: task.id, status: "done" });
    const list = await call({ action: "list" });
    expect(list.content[0].text).toContain("✅");
  });

  it("shows in-progress emoji for in-progress tasks", async () => {
    const added = await call({ action: "add", title: "Active task", description: "d" });
    const task = added.details as { id: string };
    await call({ action: "update", taskId: task.id, status: "in-progress" });
    const list = await call({ action: "list" });
    expect(list.content[0].text).toContain("🔄");
  });
});

// ── action: get ───────────────────────────────────────────────────────────────

describe("action: get", () => {
  it("returns task details by id", async () => {
    const added = await call({ action: "add", title: "Get me", description: "My desc" });
    const task = added.details as { id: string };
    const result = await call({ action: "get", taskId: task.id });
    expect(result.content[0].text).toContain("Get me");
    expect(result.content[0].text).toContain("My desc");
  });

  it("returns not-found text for unknown id", async () => {
    const result = await call({ action: "get", taskId: "task-nonexistent" });
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error text when taskId is missing", async () => {
    const result = await call({ action: "get" });
    expect(result.content[0].text).toContain("Missing taskId");
  });
});

// ── action: update ────────────────────────────────────────────────────────────

describe("action: update", () => {
  it("updates task status and returns confirmation", async () => {
    const added = await call({ action: "add", title: "Update me", description: "d" });
    const task = added.details as { id: string };
    const result = await call({ action: "update", taskId: task.id, status: "done" });
    expect(result.content[0].text).toContain("updated");
    expect(result.content[0].text).toContain("done");
  });

  it("updates task result text", async () => {
    const added = await call({ action: "add", title: "T", description: "d" });
    const task = added.details as { id: string };
    const result = await call({
      action: "update",
      taskId: task.id,
      status: "done",
      result: "Finished successfully",
    });
    expect(result.content[0].text).toContain("updated");
    const details = result.details as { result: string };
    expect(details.result).toBe("Finished successfully");
  });

  it("returns not-found text for unknown id", async () => {
    const result = await call({ action: "update", taskId: "task-ghost", status: "done" });
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error text when taskId is missing", async () => {
    const result = await call({ action: "update", status: "done" });
    expect(result.content[0].text).toContain("Missing taskId");
  });
});

// ── action: import_backlog ────────────────────────────────────────────────────

describe("action: import_backlog", () => {
  let backlogDir: string;

  beforeEach(() => {
    backlogDir = mkdtempSync(join(tmpdir(), "backlog-test-"));
    setActiveBacklogDir(backlogDir);
  });

  afterEach(() => {
    rmSync(backlogDir, { recursive: true, force: true });
  });

  function writeSpec(filename: string, content: string) {
    writeFileSync(join(backlogDir, filename), content, "utf-8");
  }

  it("reports not-found when backlog directory does not exist", async () => {
    // Reset to non-existent path
    setActiveBacklogDir(join(tmpDir, "does-not-exist"));
    const result = await call({ action: "import_backlog" });
    expect(result.content[0].text).toContain("not found");
  });

  it("reports no files when backlog directory is empty", async () => {
    const result = await call({ action: "import_backlog" });
    expect(result.content[0].text).toContain("No spec files");
  });

  it("imports a valid spec and creates a task", async () => {
    writeSpec(
      "0001-test-task.md",
      `---
id: "0001"
title: "Test task"
status: ready
priority: P1
effort: M
---
## Why
Because we need it.
`,
    );

    const result = await call({ action: "import_backlog" });
    expect(result.content[0].text).toContain("Imported 1 spec");
    expect(result.content[0].text).toContain("0001-test-task.md");
  });

  it("skips files with malformed frontmatter", async () => {
    writeSpec("9999-bad.md", "no valid frontmatter here");
    const result = await call({ action: "import_backlog" });
    expect(result.content[0].text).toContain("Skipped");
  });

  it("updates existing task on re-import", async () => {
    writeSpec(
      "0002-my-task.md",
      `---
id: "0002"
title: "My task"
status: ready
---
`,
    );
    // Import once
    await call({ action: "import_backlog" });
    // Import again — should update, not create duplicate
    const result2 = await call({ action: "import_backlog" });
    expect(result2.content[0].text).toContain("updated");
  });
});

// ── action: evaluate ─────────────────────────────────────────────────────────

describe("action: evaluate", () => {
  let backlogDir: string;

  beforeEach(() => {
    backlogDir = mkdtempSync(join(tmpdir(), "backlog-eval-test-"));
    setActiveBacklogDir(backlogDir);
  });

  afterEach(() => {
    rmSync(backlogDir, { recursive: true, force: true });
  });

  it("returns error when taskId is missing", async () => {
    const result = await call({ action: "evaluate" });
    expect(result.content[0].text).toContain("Missing taskId");
  });

  it("returns error when no spec file found for taskId", async () => {
    const result = await call({ action: "evaluate", taskId: "0099" });
    expect(result.content[0].text).toContain("No spec file found");
  });

  it("returns budget-clear status when no attempts exist yet", async () => {
    writeFileSync(
      join(backlogDir, "0001-task.md"),
      `---
id: "0001"
title: "Test task"
status: ready
evaluation:
  mode: competitive
  budget:
    max_attempts: 3
    max_cost_usd: 10
---
`,
      "utf-8",
    );

    const result = await call({ action: "evaluate", taskId: "0001" });
    expect(result.content[0].text).toContain("ready to dispatch");
  });
});

// ── action: rank ──────────────────────────────────────────────────────────────

describe("action: rank", () => {
  let backlogDir: string;

  beforeEach(() => {
    backlogDir = mkdtempSync(join(tmpdir(), "backlog-rank-test-"));
    setActiveBacklogDir(backlogDir);
  });

  afterEach(() => {
    rmSync(backlogDir, { recursive: true, force: true });
  });

  it("returns error when taskId is missing", async () => {
    const result = await call({ action: "rank" });
    expect(result.content[0].text).toContain("Missing taskId");
  });

  it("returns no-attempts-log when jsonl file does not exist", async () => {
    const result = await call({ action: "rank", taskId: "0001" });
    expect(result.content[0].text).toContain("No attempts log found");
  });

  it("shows ranked results when jsonl file exists with rows", async () => {
    const row1 = {
      attempt: 1,
      task_id: "0001",
      agent: "agent-a",
      branch: "task/0001/agent-a",
      commit: "abc1234",
      started_at: "2025-07-14T10:00:00Z",
      finished_at: "2025-07-14T10:30:00Z",
      automated: {},
      rubric: {},
      score: 4.5,
      status: "champion",
      judge: "judge",
      notes_path: "output.md",
    };
    const row2 = { ...row1, attempt: 2, agent: "agent-b", score: 3.0, status: "accepted" };
    const jsonlPath = join(backlogDir, "0001-task.attempts.jsonl");
    writeFileSync(jsonlPath, JSON.stringify(row1) + "\n" + JSON.stringify(row2) + "\n", "utf-8");

    const result = await call({ action: "rank", taskId: "0001" });
    expect(result.content[0].text).toContain("agent-a");
    expect(result.content[0].text).toContain("4.5");
    // agent-a should rank above agent-b (higher score)
    const text = result.content[0].text;
    expect(text.indexOf("agent-a")).toBeLessThan(text.indexOf("agent-b"));
  });

  it("returns no-rows text for empty jsonl file", async () => {
    const jsonlPath = join(backlogDir, "0001-empty.attempts.jsonl");
    writeFileSync(jsonlPath, "", "utf-8");
    const result = await call({ action: "rank", taskId: "0001" });
    expect(result.content[0].text).toContain("No attempt rows");
  });
});

// ── action: finalize ──────────────────────────────────────────────────────────

describe("action: finalize", () => {
  let backlogDir: string;

  beforeEach(() => {
    backlogDir = mkdtempSync(join(tmpdir(), "backlog-finalize-test-"));
    setActiveBacklogDir(backlogDir);
  });

  afterEach(() => {
    rmSync(backlogDir, { recursive: true, force: true });
  });

  it("returns error when taskId is missing", async () => {
    const result = await call({ action: "finalize" });
    expect(result.content[0].text).toContain("Missing taskId");
  });

  it("returns no-eval message when eval.json does not exist", async () => {
    const result = await call({ action: "finalize", taskId: "0001" });
    expect(result.content[0].text).toContain("No eval.json found");
    expect(result.content[0].text).toContain("Run 'evaluate' first");
  });

  it("returns no-champion message when eval.json has no champion", async () => {
    const evalJson = {
      task_id: "0001",
      generated_at: new Date().toISOString(),
      attempt_count: 1,
      budget: { attempts_used: 1, max_attempts: 3, cost_usd_used: 0, max_cost_usd: 10 },
      confidence: { score: 0.5, aboveThreshold: false, minRatio: 2.0, method: "MAD" },
      ranking: [
        { rank: 1, agent: "agent-a", score: 3.5, status: "accepted", branch: "task/0001/agent-a" },
      ],
      recommendation: "confidence below threshold — rerun recommended",
    };
    writeFileSync(join(backlogDir, "0001-task.eval.json"), JSON.stringify(evalJson), "utf-8");

    const result = await call({ action: "finalize", taskId: "0001" });
    expect(result.content[0].text).toContain("No champion");
  });

  it("returns champion details when eval.json has a champion", async () => {
    const evalJson = {
      task_id: "0001",
      generated_at: new Date().toISOString(),
      attempt_count: 1,
      budget: { attempts_used: 1, max_attempts: 3, cost_usd_used: 0, max_cost_usd: 10 },
      confidence: { score: 3.0, aboveThreshold: true, minRatio: 2.0, method: "MAD" },
      ranking: [
        { rank: 1, agent: "agent-a", score: 4.8, status: "champion", branch: "task/0001/agent-a" },
      ],
      recommendation: "champion identified — ready for task-finalize",
    };
    writeFileSync(join(backlogDir, "0001-task.eval.json"), JSON.stringify(evalJson), "utf-8");

    const result = await call({ action: "finalize", taskId: "0001" });
    expect(result.content[0].text).toContain("Champion identified");
    expect(result.content[0].text).toContain("agent-a");
    expect(result.content[0].text).toContain("task/0001/agent-a");
  });
});

// ── action: unknown ───────────────────────────────────────────────────────────

describe("action: unknown", () => {
  it("returns unknown-action error text", async () => {
    const result = await call({ action: "bogus-action" });
    expect(result.content[0].text).toContain("Unknown action");
    expect(result.content[0].text).toContain("bogus-action");
  });
});

// ── module-level dir overrides ────────────────────────────────────────────────

describe("setActiveTodosDir / resetActiveTodosDir", () => {
  it("uses the overridden directory after setActiveTodosDir", async () => {
    const altDir = mkdtempSync(join(tmpdir(), "alt-todos-"));
    try {
      setActiveTodosDir(altDir);
      const result = await call({ action: "add", title: "Alt task", description: "d" });
      expect(result.content[0].text).toContain("Task created");
      // File should be in altDir, not tmpDir
      const altTasks = join(altDir, "tasks.json");
      expect(existsSync(altTasks)).toBe(true);
    } finally {
      resetActiveTodosDir();
      setActiveTodosDir(tmpDir);
      rmSync(altDir, { recursive: true, force: true });
    }
  });
});
