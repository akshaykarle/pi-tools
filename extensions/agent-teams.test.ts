import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockApi, makeCtx, makeUI } from "./__tests__/test-utils.js";

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

// ─── Helpers shared by multi-team tests ──────────────────────────────────────

/**
 * Write a two-team project layout into `dir` and return the registered
 * team-select command handler (extracted after registering the extension).
 */
async function setupMultiTeamProject(dir: string): Promise<{
  mock: ReturnType<typeof makeMockApi>;
  handler: (_: string, ctx: unknown) => Promise<void>;
  ctx: ReturnType<typeof makeCtx>;
}> {
  // Ensure a clean module instance for every test that uses this helper.
  vi.resetModules();
  mkdirSync(join(dir, ".pi", "agents"), { recursive: true });

  writeFileSync(
    join(dir, ".pi", "agents", "researcher.md"),
    `---\nname: researcher\ndescription: Research agent\ntools: read,grep\n---\nYou are a researcher.\n`,
  );

  writeFileSync(
    join(dir, ".pi", "agents", "teams.yaml"),
    `alpha-team:\n  description: "First team"\n  workspaceMode: shared\n  maxConcurrency: 1\n  members:\n    - researcher\nbeta-team:\n  description: "Second team"\n  workspaceMode: shared\n  maxConcurrency: 1\n  members:\n    - researcher\n`,
  );

  const mock = makeMockApi();
  const { default: freshFactory } = await import("./agent-teams.js");
  freshFactory(mock.api as unknown as Parameters<typeof freshFactory>[0]);
  mock.api.getAllTools.mockReturnValue([{ name: "dispatch_agent" }, { name: "manage_tasks" }]);

  const ctx = makeCtx({ cwd: dir });
  (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
  await mock.invoke.sessionStart(ctx);

  const call = mock.api.registerCommand.mock.calls.find(
    (c: unknown[]) => c[0] === "team-select",
  );
  const handler = call![1].handler as (_: string, ctx: unknown) => Promise<void>;

  return { mock, handler, ctx };
}

// ─── Step 5: multi-team team-select path correctness ─────────────────────────

describe("team-select — multi-team run path", () => {
  it("does NOT create a run on session_start when multiple teams exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-teams-nodefer-"));
    try {
      const { ctx } = await setupMultiTeamProject(dir);
      void ctx; // session_start already ran inside setupMultiTeamProject

      // With >1 team loaded, no run directory should exist yet.
      const runsRoot = join(dir, ".pi", "agent-teams", "runs");
      expect(existsSync(runsRoot)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates run under the selected team directory, not the auto-activated first team", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-teams-selectpath-"));
    try {
      const { handler, ctx } = await setupMultiTeamProject(dir);

      // Invoke /team-select and pick beta-team.
      const selectCtx = makeCtx({ cwd: dir });
      selectCtx.ui = makeUI({ selectAnswer: "beta-team — Second team (researcher)" });

      await handler("", selectCtx);

      // Run must be under beta-team.
      const betaRunsDir = join(dir, ".pi", "agent-teams", "runs", "beta-team");
      expect(existsSync(betaRunsDir)).toBe(true);

      const runDirs = readdirSync(betaRunsDir);
      expect(runDirs).toHaveLength(1);

      const runJson = JSON.parse(
        readFileSync(join(betaRunsDir, runDirs[0]!, "run.json"), "utf-8"),
      );
      expect(runJson.team).toBe("beta-team");
      expect(runJson.status).toBe("running");

      // alpha-team must have no runs at all.
      const alphaRunsDir = join(dir, ".pi", "agent-teams", "runs", "alpha-team");
      expect(existsSync(alphaRunsDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks the previous run as interrupted when switching to a different team", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-teams-interrupt-"));
    try {
      const { handler, ctx } = await setupMultiTeamProject(dir);

      // First selection: alpha-team.
      const alphaCtx = makeCtx({ cwd: dir });
      alphaCtx.ui = makeUI({ selectAnswer: "alpha-team — First team (researcher)" });
      await handler("", alphaCtx);

      // Capture alpha run path.
      const alphaRunsDir = join(dir, ".pi", "agent-teams", "runs", "alpha-team");
      const alphaRunDirs = readdirSync(alphaRunsDir);
      expect(alphaRunDirs).toHaveLength(1);
      const alphaRunJsonPath = join(alphaRunsDir, alphaRunDirs[0]!, "run.json");

      // Second selection: beta-team (confirm defaults to true in makeUI).
      const betaCtx = makeCtx({ cwd: dir });
      betaCtx.ui = makeUI({ selectAnswer: "beta-team — Second team (researcher)" });
      await handler("", betaCtx);

      // Alpha run must be interrupted.
      const alphaRunJson = JSON.parse(readFileSync(alphaRunJsonPath, "utf-8"));
      expect(alphaRunJson.status).toBe("interrupted");

      // Beta run must exist and be running.
      const betaRunsDir = join(dir, ".pi", "agent-teams", "runs", "beta-team");
      const betaRunDirs = readdirSync(betaRunsDir);
      expect(betaRunDirs).toHaveLength(1);
      const betaRunJson = JSON.parse(
        readFileSync(join(betaRunsDir, betaRunDirs[0]!, "run.json"), "utf-8"),
      );
      expect(betaRunJson.team).toBe("beta-team");
      expect(betaRunJson.status).toBe("running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Step 6: confirmation warning before interrupting an active run ───────────

describe("team-select — confirm dialog when active run exists", () => {
  it("calls ctx.ui.confirm before switching teams when a run is active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-teams-confirmcall-"));
    try {
      const { handler, ctx } = await setupMultiTeamProject(dir);

      // Select alpha-team to create an active run.
      const alphaCtx = makeCtx({ cwd: dir });
      alphaCtx.ui = makeUI({ selectAnswer: "alpha-team — First team (researcher)" });
      await handler("", alphaCtx);

      // Now try to switch to beta-team — confirm should be called.
      const betaUI = makeUI({ selectAnswer: "beta-team — Second team (researcher)" });
      const betaCtx = makeCtx({ cwd: dir });
      betaCtx.ui = betaUI;
      await handler("", betaCtx);

      // confirm must have been invoked once.
      expect(betaUI.confirm).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancelling the confirm leaves currentRun and run directory unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-teams-cancelconfirm-"));
    try {
      const { handler, ctx } = await setupMultiTeamProject(dir);

      // Select alpha-team first.
      const alphaCtx = makeCtx({ cwd: dir });
      alphaCtx.ui = makeUI({ selectAnswer: "alpha-team — First team (researcher)" });
      await handler("", alphaCtx);

      // Record alpha run state before the cancelled switch.
      const alphaRunsDir = join(dir, ".pi", "agent-teams", "runs", "alpha-team");
      const alphaRunDirsBefore = readdirSync(alphaRunsDir);
      expect(alphaRunDirsBefore).toHaveLength(1);
      const alphaRunJsonPath = join(alphaRunsDir, alphaRunDirsBefore[0]!, "run.json");

      // Attempt switch to beta-team — user cancels the confirmation.
      const cancelUI = makeUI({ selectAnswer: "beta-team — Second team (researcher)" });
      cancelUI.confirm.mockResolvedValue(false);
      const cancelCtx = makeCtx({ cwd: dir });
      cancelCtx.ui = cancelUI;
      await handler("", cancelCtx);

      // confirm must have been called once.
      expect(cancelUI.confirm).toHaveBeenCalledTimes(1);

      // Alpha run must still be "running" — not interrupted.
      const alphaRunJson = JSON.parse(readFileSync(alphaRunJsonPath, "utf-8"));
      expect(alphaRunJson.status).toBe("running");

      // No beta-team directory must exist.
      const betaRunsDir = join(dir, ".pi", "agent-teams", "runs", "beta-team");
      expect(existsSync(betaRunsDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Re-selecting the same team ───────────────────────────────────────────────

describe("team-select — re-selecting the same active team", () => {
  it("is a no-op when the active team already has a run (no new run created, no interruption)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-teams-reselect-noop-"));
    try {
      const { handler } = await setupMultiTeamProject(dir);

      // First call: select alpha-team → creates a run.
      const alphaCtx = makeCtx({ cwd: dir });
      alphaCtx.ui = makeUI({ selectAnswer: "alpha-team — First team (researcher)" });
      await handler("", alphaCtx);

      const alphaRunsDir = join(dir, ".pi", "agent-teams", "runs", "alpha-team");
      const runsBefore = readdirSync(alphaRunsDir);
      expect(runsBefore).toHaveLength(1);
      const runIdBefore = runsBefore[0]!;

      // Second call: re-select alpha-team (same team) → must be a no-op.
      const reCtx = makeCtx({ cwd: dir });
      reCtx.ui = makeUI({ selectAnswer: "alpha-team — First team (researcher)" });
      await handler("", reCtx);

      // No new run directory must have appeared.
      const runsAfter = readdirSync(alphaRunsDir);
      expect(runsAfter).toHaveLength(1);
      expect(runsAfter[0]).toBe(runIdBefore);

      // The run must still be "running", not "interrupted".
      const runJson = JSON.parse(
        readFileSync(join(alphaRunsDir, runIdBefore, "run.json"), "utf-8"),
      );
      expect(runJson.status).toBe("running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT call ctx.ui.confirm when re-selecting the same team", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-teams-reselect-noconfirm-"));
    try {
      const { handler } = await setupMultiTeamProject(dir);

      // Establish an active run on alpha-team.
      const alphaCtx = makeCtx({ cwd: dir });
      alphaCtx.ui = makeUI({ selectAnswer: "alpha-team — First team (researcher)" });
      await handler("", alphaCtx);

      // Re-select the same team with a fresh ui so we can spy on confirm.
      const reUI = makeUI({ selectAnswer: "alpha-team — First team (researcher)" });
      const reCtx = makeCtx({ cwd: dir });
      reCtx.ui = reUI;
      await handler("", reCtx);

      // confirm must never have been called.
      expect(reUI.confirm).not.toHaveBeenCalled();
      // notifyTeamActive() fires on re-select, so notify must have been called.
      expect(reUI.notify).toHaveBeenCalledWith(
        expect.stringContaining("alpha-team"),
        "info",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls through and creates a run when re-selecting the auto-activated team with no run yet (multi-team deferred path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-teams-reselect-deferred-"));
    try {
      const { handler } = await setupMultiTeamProject(dir);

      // session_start with two teams defers run creation — no run exists yet.
      const runsRoot = join(dir, ".pi", "agent-teams", "runs");
      expect(existsSync(runsRoot)).toBe(false);

      // Select alpha-team (the auto-activated team) for the first time.
      // currentRun is null so the no-op guard must not fire and a run must be created.
      const alphaCtx = makeCtx({ cwd: dir });
      alphaCtx.ui = makeUI({ selectAnswer: "alpha-team — First team (researcher)" });
      await handler("", alphaCtx);

      const alphaRunsDir = join(dir, ".pi", "agent-teams", "runs", "alpha-team");
      expect(existsSync(alphaRunsDir)).toBe(true);
      const runDirs = readdirSync(alphaRunsDir);
      expect(runDirs).toHaveLength(1);

      const runJson = JSON.parse(
        readFileSync(join(alphaRunsDir, runDirs[0]!, "run.json"), "utf-8"),
      );
      expect(runJson.team).toBe("alpha-team");
      expect(runJson.status).toBe("running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT show confirm when switching to a different team with no active run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-teams-switch-norun-"));
    try {
      const { handler } = await setupMultiTeamProject(dir);

      // Switch from auto-activated alpha-team (no run) straight to beta-team.
      const betaUI = makeUI({ selectAnswer: "beta-team — Second team (researcher)" });
      const betaCtx = makeCtx({ cwd: dir });
      betaCtx.ui = betaUI;
      await handler("", betaCtx);

      // confirm must not have been called — there was no run to interrupt.
      expect(betaUI.confirm).not.toHaveBeenCalled();

      // A run must have been created under beta-team.
      const betaRunsDir = join(dir, ".pi", "agent-teams", "runs", "beta-team");
      expect(existsSync(betaRunsDir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worktree mode", () => {
  const execFileSyncMock = execFileSync as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execFileSyncMock.mockReset();

    // Default git responses (execFileSync is called as execFileSync("git", args, opts)):
    // rev-parse --show-toplevel → tmpDir (repoRoot)
    // status --porcelain        → "" (clean working tree)
    // worktree add              → "" (success)
    // branch --show-current     → "run-test-branch"
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--show-toplevel")) return tmpDir;
      if (args.includes("--porcelain")) return "";
      if (args.includes("add")) return "";
      if (args.includes("--show-current")) return "run-test-branch";
      return "";
    });
  });

  it("two dispatches in the same run share one worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-test-"));
    try {
      const agentsDir = join(dir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });

      writeFileSync(
        join(agentsDir, "researcher.md"),
        `---
name: researcher
description: Research agent
tools: read
---
You are a researcher.
`,
      );
      writeFileSync(
        join(agentsDir, "implementer.md"),
        `---
name: implementer
description: Implementer agent
---
You are an implementer.
`,
      );
      writeFileSync(
        join(agentsDir, "teams.yaml"),
        `wt-team:
  description: "Worktree team"
  workspaceMode: worktree
  maxConcurrency: 2
  members:
    - researcher
    - implementer
`,
      );

      vi.resetModules();
      const { default: freshFactory } = await import("./agent-teams.js");
      const mock = makeMockApi();
      freshFactory(mock.api as unknown as Parameters<typeof freshFactory>[0]);
      mock.api.getAllTools.mockReturnValue([{ name: "dispatch_agent" }, { name: "manage_tasks" }]);

      const ctx = makeCtx({ cwd: dir });
      (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
      (ctx as Record<string, unknown>).getActiveTools = () => [];
      await mock.invoke.sessionStart(ctx);

      const toolCall = mock.api.registerTool.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === "dispatch_agent",
      );
      const execute = (toolCall![0] as { execute: Function }).execute;

      spawnMock.mockReset();
      execFileSyncMock.mockReset();
      execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes("--show-toplevel")) return tmpDir;
        if (args.includes("--porcelain")) return "";
        if (args.includes("add")) return "";
        if (args.includes("--show-current")) return "run-test-branch";
        return "";
      });

      // Dispatch two agents.
      await execute("call-a", { agent: "researcher", taskId: "task-1", task: "research something" }, undefined, undefined, ctx);
      await execute("call-b", { agent: "implementer", taskId: "task-2", task: "implement something" }, undefined, undefined, ctx);

      // git worktree add should have been called exactly once.
      const worktreeAddCalls = execFileSyncMock.mock.calls.filter(
        (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes("add"),
      );
      expect(worktreeAddCalls).toHaveLength(1);

      // Both spawned agents should have received the same cwd.
      // spawnMock is called as spawn("pi", args, { cwd, ... })
      const cwds = spawnMock.mock.calls.map((c: unknown[]) => (c[2] as { cwd?: string })?.cwd);
      expect(cwds).toHaveLength(2);
      expect(cwds[0]).toBe(cwds[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls git worktree remove on session_shutdown when cleanupWorktree: true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-cleanup-test-"));
    const agentsDir = join(dir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "researcher.md"), `---
name: researcher
description: Research agent
tools: read
---
You are a researcher.
`);
    writeFileSync(join(agentsDir, "teams.yaml"), `wt-team:
  description: "Worktree team"
  workspaceMode: worktree
  cleanupWorktree: true
  maxConcurrency: 1
  members:
    - researcher
`);

    vi.resetModules();
    const { default: freshFactory } = await import("./agent-teams.js");
    const mock = makeMockApi();
    freshFactory(mock.api as unknown as Parameters<typeof freshFactory>[0]);
    mock.api.getAllTools.mockReturnValue([{ name: "dispatch_agent" }, { name: "manage_tasks" }]);

    const ctx = makeCtx({ cwd: dir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];
    await mock.invoke.sessionStart(ctx);

    // Configure execFileSync mock.
    (execFileSync as ReturnType<typeof vi.fn>).mockReset();
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--show-toplevel")) return dir;
      if (args.includes("--porcelain")) return "";
      if (args.includes("add")) return "";
      if (args.includes("--show-current")) return "run-test-branch";
      return "";
    });

    // Dispatch one agent to create the shared worktree.
    const toolCall = mock.api.registerTool.mock.calls.find(
      (c: unknown[]) => (c[0] as { name: string }).name === "dispatch_agent",
    );
    const execute = (toolCall![0] as { execute: Function }).execute;
    spawnMock.mockReset();
    await execute("call-a", { agent: "researcher", taskId: "task-1", task: "do research" }, undefined, undefined, ctx);

    // Clear so we can assert on shutdown calls only.
    (execFileSync as ReturnType<typeof vi.fn>).mockClear();

    // Trigger session shutdown.
    await mock.invoke.sessionShutdown(ctx);

    // Should have called `git worktree remove <path>`.
    const removeCalls = (execFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes("remove"),
    );
    expect(removeCalls.length).toBeGreaterThan(0);

    // Should NOT have called `git branch -D` (deleteBranch: false).
    const branchDeleteCalls = (execFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[0] === "branch" && (c[1] as string[]).includes("-D"),
    );
    expect(branchDeleteCalls).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("notifies user of branch name on session_shutdown after worktree run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-notify-test-"));
    const agentsDir = join(dir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "researcher.md"), `---
name: researcher
description: Research agent
tools: read
---
You are a researcher.
`);
    writeFileSync(join(agentsDir, "teams.yaml"), `wt-team:
  description: "Worktree team"
  workspaceMode: worktree
  maxConcurrency: 1
  members:
    - researcher
`);

    vi.resetModules();
    const { default: freshFactory } = await import("./agent-teams.js");
    const mock = makeMockApi();
    freshFactory(mock.api as unknown as Parameters<typeof freshFactory>[0]);
    mock.api.getAllTools.mockReturnValue([{ name: "dispatch_agent" }, { name: "manage_tasks" }]);

    const ctx = makeCtx({ cwd: dir });
    (ctx as Record<string, unknown>).model = { provider: "anthropic", id: "test-model" };
    (ctx as Record<string, unknown>).getActiveTools = () => [];
    await mock.invoke.sessionStart(ctx);

    (execFileSync as ReturnType<typeof vi.fn>).mockReset();
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--show-toplevel")) return dir;
      if (args.includes("--porcelain")) return "";
      if (args.includes("add")) return "";
      if (args.includes("--show-current")) return "run-test-branch";
      return "";
    });

    const toolCall = mock.api.registerTool.mock.calls.find(
      (c: unknown[]) => (c[0] as { name: string }).name === "dispatch_agent",
    );
    const execute = (toolCall![0] as { execute: Function }).execute;
    spawnMock.mockReset();
    await execute("call-a", { agent: "researcher", taskId: "task-1", task: "do research" }, undefined, undefined, ctx);

    // Clear notification history from the dispatch phase.
    (ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();

    await mock.invoke.sessionShutdown(ctx);

    // At least one notification should mention the preserved branch.
    // The branch name is derived from the runId (sanitized), not from the git mock.
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    const branchNotice = notifyCalls.find(([msg]) => msg.includes("Worktree branch preserved:"));
    expect(branchNotice).toBeDefined();

    rmSync(dir, { recursive: true, force: true });
  });
});
