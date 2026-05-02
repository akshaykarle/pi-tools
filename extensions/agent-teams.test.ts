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
  tmpDir = mkdtempSync(join(tmpdir(), "agent-teams-ext-test-"));
  setupProject(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function setup() {
  const mock = makeMockApi();
  extensionFactory(mock.api as unknown as Parameters<typeof extensionFactory>[0]);
  return mock;
}

describe("agent-teams extension", () => {
  it("registers dispatch_agent and manage_tasks tools", () => {
    const mock = setup();
    expect(mock.api.registerTool).toHaveBeenCalledTimes(2);

    const toolNames = mock.api.registerTool.mock.calls.map(
      (call: unknown[]) => (call[0] as { name: string }).name,
    );
    expect(toolNames).toContain("dispatch_agent");
    expect(toolNames).toContain("manage_tasks");
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

  it("manage_tasks tool can add and list tasks", async () => {
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
