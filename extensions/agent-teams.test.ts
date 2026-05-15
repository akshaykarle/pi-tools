import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockApi, makeCtx } from "./__tests__/test-utils.js";

// Mock parseFrontmatter (same as agent-loader test).
vi.mock("@mariozechner/pi-coding-agent", () => ({
  parseFrontmatter: <T extends Record<string, unknown>>(
    content: string,
  ): { frontmatter: T; body: string } => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { frontmatter: {} as T, body: content };
    const frontmatter: Record<string, unknown> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return { frontmatter: frontmatter as T, body: match[2] };
  },
  isToolCallEventType: (toolName: string, event: { toolName?: string }) =>
    event.toolName === toolName,
}));

// Mock child_process.spawn so we don't actually launch pi processes.
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFileSync: vi.fn(),
}));

import extensionFactory from "./agent-teams.js";

let tmpDir: string;

function setupProject(dir: string) {
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });

  writeFileSync(
    join(agentsDir, "researcher.md"),
    `---
name: researcher
description: Research agent
tools: read,grep,find,ls
---
You are a researcher.
`,
  );

  writeFileSync(
    join(agentsDir, "implementer.md"),
    `---
name: implementer
description: Implementation agent
---
You are an implementer.
`,
  );

  writeFileSync(
    join(agentsDir, "teams.yaml"),
    `test-team:
  description: "Test team"
  workspaceMode: shared
  maxConcurrency: 2
  members:
    - researcher
    - implementer
`,
  );
}

beforeEach(() => {
  // Clear the child agent guard so the extension initializes properly
  delete process.env.PI_AGENT_TEAMS_CHILD;
  tmpDir = mkdtempSync(join(tmpdir(), "agent-teams-ext-test-"));
  setupProject(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function setup() {
  const mock = makeMockApi();
  extensionFactory(mock.api as unknown as Parameters<typeof extensionFactory>[0]);
  mock.api.getAllTools.mockReturnValue([{ name: "dispatch_agent" }, { name: "manage_tasks" }]);
  return mock;
}

describe("agent-teams extension", () => {
  it("registers only dispatch_agent tool (manage_tasks is in todos extension)", () => {
    const mock = setup();
    expect(mock.api.registerTool).toHaveBeenCalledTimes(1);

    const toolNames = mock.api.registerTool.mock.calls.map(
      (call: unknown[]) => (call[0] as { name: string }).name,
    );
    expect(toolNames).toContain("dispatch_agent");
    expect(toolNames).not.toContain("manage_tasks");
  });

  it("registers team commands", () => {
    const mock = setup();
    const commandNames = mock.api.registerCommand.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(commandNames).toContain("team-select");
    expect(commandNames).toContain("team-list");
    expect(commandNames).toContain("team-status");
    expect(commandNames).toContain("team-handoffs");
  });

  it("loads agents and team on session_start", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => ["read", "write", "bash"];

    await mock.invoke.sessionStart(ctx);

    // Should notify about loading.
    expect(mock.api.setActiveTools).toHaveBeenCalledWith(["dispatch_agent", "manage_tasks"]);

    // Status bar should be set.
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "agent-team",
      expect.stringContaining("test-team"),
    );
  });

  it("injects orchestrator system prompt via before_agent_start", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];

    await mock.invoke.sessionStart(ctx);

    // Find the before_agent_start handler.
    const beforeAgentCalls = mock.api.on.mock.calls.filter(
      (call: unknown[]) => call[0] === "before_agent_start",
    );
    expect(beforeAgentCalls).toHaveLength(1);

    const handler = beforeAgentCalls[0][1] as (event: unknown, ctx: unknown) => Promise<unknown>;
    const result = (await handler({}, ctx)) as { systemPrompt?: string };

    expect(result?.systemPrompt).toContain("orchestrator agent");
    expect(result?.systemPrompt).toContain("Researcher");
    expect(result?.systemPrompt).toContain("Implementer");
    expect(result?.systemPrompt).toContain("dispatch_agent");
  });

  it.skip("manage_tasks tool can add and list tasks", async () => {
    // This test has been moved to extensions/todos/task-board.test.ts since manage_tasks
    // is now registered by the todos extension, not agent-teams.
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];

    await mock.invoke.sessionStart(ctx);

    // Get the manage_tasks tool.
    const manageTasksTool = mock.api.registerTool.mock.calls.find(
      (call: unknown[]) => (call[0] as { name: string }).name === "manage_tasks",
    )?.[0] as { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

    expect(manageTasksTool).toBeDefined();

    // Add a task.
    const addResult = await manageTasksTool.execute(
      "call-1",
      { action: "add", title: "Test task", description: "A test task" },
      undefined,
      undefined,
      ctx,
    );
    expect(addResult.content[0].text).toContain("Task created");

    // List tasks.
    const listResult = await manageTasksTool.execute(
      "call-2",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    expect(listResult.content[0].text).toContain("Test task");
  });

  it("creates run directory structure under team name", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];

    await mock.invoke.sessionStart(ctx);

    // Check that runs dir was created under team name.
    const runsDir = join(tmpDir, ".pi", "agent-teams", "runs", "test-team");
    expect(existsSync(runsDir)).toBe(true);

    // Should have exactly one run directory.
    const { readdirSync } = await import("node:fs");
    const runDirs = readdirSync(runsDir);
    expect(runDirs).toHaveLength(1);
    expect(runDirs[0]).toMatch(/^run-\d+-[a-f0-9]+$/);

    // run.json should exist.
    const runJson = JSON.parse(
      readFileSync(join(runsDir, runDirs[0], "run.json"), "utf-8"),
    );
    expect(runJson.team).toBe("test-team");
    expect(runJson.status).toBe("running");
  });
});

describe("team-off", () => {
  let tmpDir2: string;

  beforeEach(() => {
    tmpDir2 = mkdtempSync(join(tmpdir(), "agent-teams-team-off-test-"));
    setupProject(tmpDir2);
  });

  afterEach(() => {
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it("is a no-op when team mode is not active", async () => {
    // Reset the module registry so agent-teams.ts re-initialises with clean
    // module-level state (teamAgents empty, activeTeamName "").
    vi.resetModules();
    const { default: freshFactory } = await import("./agent-teams.js");
    const mock = makeMockApi();
    freshFactory(mock.api as unknown as Parameters<typeof freshFactory>[0]);

    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-off",
    );
    const teamOffHandler = call![1].handler as (_args: string, ctx: unknown) => Promise<void>;

    const ctx = makeCtx({ cwd: tmpDir2 });

    // Team mode was never activated — invoke team-off directly.
    await teamOffHandler("", ctx);

    // setActiveTools must NOT have been called.
    expect(mock.api.setActiveTools).not.toHaveBeenCalled();

    // Should notify that team mode is not active.
    expect(ctx.ui.notify).toHaveBeenCalledWith("Team mode is not active.", "info");
  });

  it("disables team mode and restores tools (filtering out dispatch_agent and manage_tasks)", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir2 });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];

    // Activate team mode.
    await mock.invoke.sessionStart(ctx);

    // Extract the team-off handler BEFORE clearing mocks.
    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-off",
    );
    const teamOffHandler = call![1].handler as (_args: string, ctx: unknown) => Promise<void>;

    // Mock getAllTools to return the full set including agent-team tools.
    mock.api.getAllTools.mockReturnValue([
      { name: "read" },
      { name: "write" },
      { name: "bash" },
      { name: "dispatch_agent" },
      { name: "manage_tasks" },
    ]);

    // Clear call history so assertions below are clean.
    vi.clearAllMocks();

    await teamOffHandler("", ctx);

    // dispatch_agent and manage_tasks must be filtered out of the restored set.
    expect(mock.api.setActiveTools).toHaveBeenLastCalledWith(["read", "write", "bash"]);

    const restoredTools = mock.api.setActiveTools.mock.calls.at(-1)![0] as string[];
    expect(restoredTools).not.toContain("dispatch_agent");
    expect(restoredTools).not.toContain("manage_tasks");

    // Status bar entry should be cleared.
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("agent-team", undefined);

    // User should be notified.
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Team mode disabled. Full tool access restored.",
      "info",
    );
  });

  it("marks the current run as interrupted on disk", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir2 });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];

    // Activate team mode — this creates a run on disk.
    await mock.invoke.sessionStart(ctx);

    // Extract the team-off handler BEFORE clearing mocks.
    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-off",
    );
    const teamOffHandler = call![1].handler as (_args: string, ctx: unknown) => Promise<void>;

    // Find the run directory created on disk.
    const { readdirSync } = await import("node:fs");
    const runsDir = join(tmpDir2, ".pi", "agent-teams", "runs", "test-team");
    const runDirs = readdirSync(runsDir);
    expect(runDirs).toHaveLength(1);
    const runJsonPath = join(runsDir, runDirs[0], "run.json");

    // Confirm the run is "running" before team-off.
    const before = JSON.parse(readFileSync(runJsonPath, "utf-8"));
    expect(before.status).toBe("running");

    await teamOffHandler("", ctx);

    // After team-off the run should be marked "interrupted" on disk.
    const after = JSON.parse(readFileSync(runJsonPath, "utf-8"));
    expect(after.status).toBe("interrupted");
  });
});

describe("team-list command", () => {
  it("notifies 'no agents loaded' when team is not active", async () => {
    vi.resetModules();
    const { default: freshFactory } = await import("./agent-teams.js");
    const mock = makeMockApi();
    freshFactory(mock.api as unknown as Parameters<typeof freshFactory>[0]);

    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-list",
    );
    const handler = call![1].handler as (_: string, ctx: unknown) => Promise<void>;
    const ctx = makeCtx({ cwd: tmpDir });
    await handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/no agents loaded/i),
      "warning",
    );
  });

  it("lists agents when team is active", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];
    await mock.invoke.sessionStart(ctx);

    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-list",
    );
    const handler = call![1].handler as (_: string, ctx: unknown) => Promise<void>;
    await handler("", ctx);

    // Should have notified with agent info.
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const lastNotify = notifyCalls[notifyCalls.length - 1]?.[0] as string;
    expect(lastNotify).toContain("Researcher");
    expect(lastNotify).toContain("Implementer");
  });
});

describe("team-status command", () => {
  it("notifies 'no active run' when no run is started", async () => {
    vi.resetModules();
    const { default: freshFactory } = await import("./agent-teams.js");
    const mock = makeMockApi();
    freshFactory(mock.api as unknown as Parameters<typeof freshFactory>[0]);

    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-status",
    );
    const handler = call![1].handler as (_: string, ctx: unknown) => Promise<void>;
    const ctx = makeCtx({ cwd: tmpDir });
    await handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/no active run/i),
      "info",
    );
  });

  it("shows run information when run is active", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];
    await mock.invoke.sessionStart(ctx);

    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-status",
    );
    const handler = call![1].handler as (_: string, ctx: unknown) => Promise<void>;
    await handler("", ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const lastNotify = notifyCalls[notifyCalls.length - 1]?.[0] as string;
    expect(lastNotify).toContain("Run:");
    expect(lastNotify).toContain("test-team");
  });

  it("shows tasks with correct status icons", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];
    await mock.invoke.sessionStart(ctx);

    // Add tasks with different statuses to the run directory.
    const { readdirSync } = await import("node:fs");
    const runsDir = join(tmpDir, ".pi", "agent-teams", "runs", "test-team");
    const runDirs = readdirSync(runsDir);
    const runDirPath = join(runsDir, runDirs[0]);

    const { addTask, updateTask } = await import("./todos.js");
    const t1 = addTask(runDirPath, { title: "Done task", description: "d", dependencies: [] });
    updateTask(runDirPath, t1.id, { status: "done" });
    const t2 = addTask(runDirPath, { title: "Failed task", description: "d", dependencies: [] });
    updateTask(runDirPath, t2.id, { status: "failed" });
    const t3 = addTask(runDirPath, { title: "Active task", description: "d", dependencies: [] });
    updateTask(runDirPath, t3.id, { status: "in-progress" });
    addTask(runDirPath, { title: "Queued task", description: "d", dependencies: [] });

    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-status",
    );
    const handler = call![1].handler as (_: string, ctx: unknown) => Promise<void>;
    await handler("", ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const lastNotify = notifyCalls[notifyCalls.length - 1]?.[0] as string;
    expect(lastNotify).toContain("✅");
    expect(lastNotify).toContain("❌");
    expect(lastNotify).toContain("🔄");
    expect(lastNotify).toContain("⏳");
  });
});

describe("team-handoffs command", () => {
  it("notifies 'no active run' when run dir is not set", async () => {
    vi.resetModules();
    const { default: freshFactory } = await import("./agent-teams.js");
    const mock = makeMockApi();
    freshFactory(mock.api as unknown as Parameters<typeof freshFactory>[0]);

    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-handoffs",
    );
    const handler = call![1].handler as (_: string, ctx: unknown) => Promise<void>;
    const ctx = makeCtx({ cwd: tmpDir });
    await handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/no active run/i),
      "info",
    );
  });

  it("shows 'no handoffs yet' when run is active but log is empty", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];
    await mock.invoke.sessionStart(ctx);

    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-handoffs",
    );
    const handler = call![1].handler as (_: string, ctx: unknown) => Promise<void>;
    await handler("", ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const lastNotify = notifyCalls[notifyCalls.length - 1]?.[0] as string;
    expect(lastNotify).toMatch(/no handoffs/i);
  });
});

describe("session_start — no agents found", () => {
  it("notifies 'no agents found' when agents directory is empty", async () => {
    vi.resetModules();
    const tmpDirEmpty = mkdtempSync(join(tmpdir(), "agent-teams-empty-"));
    // Create team dir but no agent definitions.
    mkdirSync(join(tmpDirEmpty, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(tmpDirEmpty, ".pi", "agents", "teams.yaml"),
      `test-team:
  description: "Empty team"
  workspaceMode: shared
  maxConcurrency: 1
  members: []
`,
    );

    try {
      const { default: freshFactory } = await import("./agent-teams.js");
      const mock = makeMockApi();
      freshFactory(mock.api as unknown as Parameters<typeof freshFactory>[0]);

      const ctx = makeCtx({ cwd: tmpDirEmpty });
      (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
      (ctx as Record<string, unknown>).getActiveTools = () => [];
      await mock.invoke.sessionStart(ctx);

      // Should notify about no agents.
      const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
      const msgs = notifyCalls.map((c: unknown[]) => c[0] as string);
      expect(msgs.some((m) => m.includes("No agents found"))).toBe(true);
    } finally {
      rmSync(tmpDirEmpty, { recursive: true, force: true });
    }
  });
});

describe("team-handoffs — with handoffs", () => {
  it("shows handoff entries when they exist", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];
    await mock.invoke.sessionStart(ctx);

    // Get the run directory and write a handoff entry.
    const { readdirSync } = await import("node:fs");
    const runsDir = join(tmpDir, ".pi", "agent-teams", "runs", "test-team");
    const runDirs = readdirSync(runsDir);
    const runDirPath = join(runsDir, runDirs[0]);

    const { appendHandoff } = await import("./agent-teams/handoff-log.js");
    appendHandoff(runDirPath, {
      type: "dispatch",
      runId: runDirs[0],
      fromAgent: "orchestrator",
      toAgent: "researcher",
      taskId: "task-1",
      summary: "Research the codebase",
      elapsedMs: 5000,
    });

    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-handoffs",
    );
    const handler = call![1].handler as (_: string, ctx: unknown) => Promise<void>;
    await handler("", ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const lastNotify = notifyCalls[notifyCalls.length - 1]?.[0] as string;
    expect(lastNotify).toContain("researcher");
    expect(lastNotify).toContain("Research the codebase");
  });

  it("shows correct icons for completion/failure/other handoff types and truncates long summaries", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];
    await mock.invoke.sessionStart(ctx);

    const { readdirSync } = await import("node:fs");
    const runsDir = join(tmpDir, ".pi", "agent-teams", "runs", "test-team");
    const runDirs = readdirSync(runsDir);
    const runDirPath = join(runsDir, runDirs[0]);

    const { appendHandoff } = await import("./agent-teams/handoff-log.js");
    const runId = runDirs[0];
    appendHandoff(runDirPath, { type: "completion", runId, fromAgent: "researcher", toAgent: "orchestrator", taskId: "t1", summary: "Done" });
    appendHandoff(runDirPath, { type: "failure", runId, fromAgent: "implementer", toAgent: "orchestrator", taskId: "t2", summary: "Failed" });
    // 'other' type (not dispatch/completion/failure) triggers the else branch.
    appendHandoff(runDirPath, { type: "update" as "dispatch", runId, fromAgent: "a", toAgent: "b", taskId: "t3", summary: "x".repeat(110) });

    const call = mock.api.registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "team-handoffs",
    );
    const handler = call![1].handler as (_: string, ctx: unknown) => Promise<void>;
    await handler("", ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const lastNotify = notifyCalls[notifyCalls.length - 1]?.[0] as string;
    // Completion icon.
    expect(lastNotify).toContain("✅");
    // Failure icon.
    expect(lastNotify).toContain("❌");
    // Long summary truncated.
    expect(lastNotify).toContain("...");
  });
});

describe("session_shutdown", () => {
  it("marks run as 'completed' when all tasks are done on shutdown", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];

    await mock.invoke.sessionStart(ctx);

    // Find the run directory.
    const { readdirSync } = await import("node:fs");
    const runsDir = join(tmpDir, ".pi", "agent-teams", "runs", "test-team");
    const runDirs = readdirSync(runsDir);
    const runDirPath = join(runsDir, runDirs[0]);

    // Add a task and mark it done so allDone is true.
    const { addTask, updateTask } = await import("./todos.js");
    const task = addTask(runDirPath, { title: "T", description: "d", dependencies: [] });
    updateTask(runDirPath, task.id, { status: "done" });

    // Find and invoke the session_shutdown handler.
    const shutdownCalls = mock.api.on.mock.calls.filter(
      (c: unknown[]) => c[0] === "session_shutdown",
    );
    const shutdownHandler = shutdownCalls[0][1] as (e: unknown, ctx: unknown) => Promise<void>;
    await shutdownHandler({}, ctx);

    const runJsonPath = join(runDirPath, "run.json");
    const runJson = JSON.parse(readFileSync(runJsonPath, "utf-8"));
    expect(runJson.status).toBe("completed");
  });

  it("marks run as 'interrupted' when tasks are still in progress on shutdown", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];

    await mock.invoke.sessionStart(ctx);

    const { readdirSync } = await import("node:fs");
    const runsDir = join(tmpDir, ".pi", "agent-teams", "runs", "test-team");
    const runDirs = readdirSync(runsDir);
    const runDirPath = join(runsDir, runDirs[0]);

    // Add a queued task (not done) — allDone will be false.
    const { addTask } = await import("./todos.js");
    addTask(runDirPath, { title: "Pending", description: "d", dependencies: [] });

    const shutdownCalls = mock.api.on.mock.calls.filter(
      (c: unknown[]) => c[0] === "session_shutdown",
    );
    const shutdownHandler = shutdownCalls[0][1] as (e: unknown, ctx: unknown) => Promise<void>;
    await shutdownHandler({}, ctx);

    const runJsonPath = join(runDirPath, "run.json");
    const runJson = JSON.parse(readFileSync(runJsonPath, "utf-8"));
    expect(runJson.status).toBe("interrupted");
  });
});

describe("dispatch_agent tool", () => {
  it("returns error text when agent name is not found in the team", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];
    await mock.invoke.sessionStart(ctx);

    const toolCall = mock.api.registerTool.mock.calls.find(
      (c: unknown[]) => (c[0] as { name: string }).name === "dispatch_agent",
    );
    const execute = (toolCall![0] as { execute: Function }).execute;

    const result = await execute(
      "call-1",
      { agent: "nonexistent-agent", taskId: "task-1", task: "do something" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("not found");
    expect(result.details.status).toBe("error");
  });

  it("dispatch_agent calls onUpdate with dispatching status", async () => {
    const mock = setup();
    const ctx = makeCtx({ cwd: tmpDir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];
    await mock.invoke.sessionStart(ctx);

    const toolCall = mock.api.registerTool.mock.calls.find(
      (c: unknown[]) => (c[0] as { name: string }).name === "dispatch_agent",
    );
    const execute = (toolCall![0] as { execute: Function }).execute;

    const updates: unknown[] = [];
    const onUpdate = (u: unknown) => updates.push(u);

    // researcher is a valid agent — it will fail because spawnMock returns early.
    // That's fine; we just want to verify onUpdate was called.
    await execute(
      "call-2",
      { agent: "researcher", taskId: "task-1", task: "do something" },
      undefined,
      onUpdate,
      ctx,
    );

    expect(updates.length).toBeGreaterThan(0);
    const first = updates[0] as { content: Array<{ text: string }> };
    expect(first.content[0].text).toContain("Dispatching");
  });
});
