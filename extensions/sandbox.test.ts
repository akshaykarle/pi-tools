import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCtx, makeMockApi } from "./__tests__/test-utils.js";

// --- Mocks ---
//
// vi.mock factories are hoisted above top-level declarations. Use vi.hoisted
// so the spies are available before our `import sandboxFactory` runs the
// extension's own imports.

const {
  initializeMock,
  resetMock,
  wrapWithSandboxMock,
  updateConfigMock,
  isSupportedPlatformMock,
  spawnMock,
} = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  resetMock: vi.fn(),
  wrapWithSandboxMock: vi.fn(),
  updateConfigMock: vi.fn(),
  isSupportedPlatformMock: vi.fn(() => true),
  spawnMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: initializeMock,
    reset: resetMock,
    wrapWithSandbox: wrapWithSandboxMock,
    updateConfig: updateConfigMock,
    isSupportedPlatform: isSupportedPlatformMock,
    isSandboxingEnabled: vi.fn(() => true),
    cleanupAfterCommand: vi.fn(),
    getConfig: vi.fn(),
  },
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => process.env.__TEST_AGENT_DIR__ ?? "/tmp/test-agent-dir",
  isToolCallEventType: (toolName: string, event: { toolName?: string }) =>
    event.toolName === toolName,
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// Now import the extension under test (after mocks are registered).
import sandboxFactory, { __testing__ } from "./sandbox.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sb-"));
  process.env.__TEST_AGENT_DIR__ = tmp;
  __testing__.reset();
  vi.clearAllMocks();
  isSupportedPlatformMock.mockReturnValue(true);
  initializeMock.mockResolvedValue(undefined);
  resetMock.mockResolvedValue(undefined);
  wrapWithSandboxMock.mockImplementation(async (cmd: string) => `WRAPPED(${cmd})`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.__TEST_AGENT_DIR__;
  vi.unstubAllEnvs();
});

function setup(opts?: { noSandbox?: boolean }) {
  const mock = makeMockApi();
  // Cast through unknown — test-utils intentionally avoids importing real types.
  sandboxFactory(mock.api as unknown as Parameters<typeof sandboxFactory>[0]);
  // Flip the flag AFTER the factory runs, otherwise registerFlag's default resets it.
  if (opts?.noSandbox) mock.api.setFlag("no-sandbox", true);
  return mock;
}

describe("session_start — env scrubbing", () => {
  it("deletes all DEFAULT_STRIP_VARS from process.env", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-secret");
    vi.stubEnv("GH_TOKEN", "ghp-secret");
    vi.stubEnv("UNRELATED_VAR", "keep-me");
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");

    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(process.env.GH_TOKEN).toBeUndefined();
    expect(process.env.UNRELATED_VAR).toBe("keep-me");
  });

  it("deletes additional vars from merged config.env.strip", async () => {
    vi.stubEnv("CUSTOM_PROJECT_SECRET", "x");
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");

    mkdirSync(join(tmp, ".pi-test"));
    writeFileSync(
      join(tmp, ".pi-test", "sandbox.json"),
      JSON.stringify({ env: { strip: ["CUSTOM_PROJECT_SECRET"] } }),
    );

    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));
    expect(process.env.CUSTOM_PROJECT_SECRET).toBeUndefined();
  });

  it("env scrub fires BEFORE SandboxManager.initialize", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");

    const order: string[] = [];
    initializeMock.mockImplementation(async () => {
      order.push(`init:ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? ""}`);
    });

    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    // initialize observed an empty value → scrub ran first.
    expect(order).toEqual(["init:ANTHROPIC_API_KEY="]);
  });

  it("scrubs even when --no-sandbox is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");

    const mock = setup({ noSandbox: true });
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(initializeMock).not.toHaveBeenCalled();
  });

  it("scrubs even when config sets enabled:false", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");

    mkdirSync(join(tmp, ".pi-test"));
    writeFileSync(
      join(tmp, ".pi-test", "sandbox.json"),
      JSON.stringify({ enabled: false }),
    );

    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(initializeMock).not.toHaveBeenCalled();
  });
});

describe("session_start — initialization paths", () => {
  it("happy path: enabled + supported platform → initialize + sandboxEnabled", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");

    const mock = setup();
    const ctx = makeCtx({ cwd: tmp });
    await mock.invoke.sessionStart(ctx);

    expect(initializeMock).toHaveBeenCalledOnce();
    const passedConfig = initializeMock.mock.calls[0][0];
    expect(passedConfig.network.allowedDomains).toContain("api.anthropic.com");
    expect(passedConfig.filesystem.denyRead).toContain("~/.ssh");

    const state = __testing__.state();
    expect(state.sandboxEnabled).toBe(true);
    expect(state.sandboxFailed).toBe(false);
    expect(state.toolGuardEnabled).toBe(true);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "sandbox",
      expect.stringContaining("Sandbox:"),
    );
  });

  it("--no-sandbox: skip initialize, tool guard off", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup({ noSandbox: true });
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    expect(initializeMock).not.toHaveBeenCalled();
    const state = __testing__.state();
    expect(state.sandboxEnabled).toBe(false);
    expect(state.toolGuardEnabled).toBe(false);
  });

  it("config enabled:false: skip initialize, tool guard off", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    mkdirSync(join(tmp, ".pi-test"));
    writeFileSync(join(tmp, ".pi-test", "sandbox.json"), JSON.stringify({ enabled: false }));

    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    expect(initializeMock).not.toHaveBeenCalled();
    expect(__testing__.state().toolGuardEnabled).toBe(false);
  });

  it("initialize throws → sandboxFailed=true, toolGuardEnabled=true", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    initializeMock.mockRejectedValue(new Error("bwrap missing"));

    const mock = setup();
    const ctx = makeCtx({ cwd: tmp });
    await mock.invoke.sessionStart(ctx);

    const state = __testing__.state();
    expect(state.sandboxFailed).toBe(true);
    expect(state.sandboxEnabled).toBe(false);
    expect(state.toolGuardEnabled).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Sandbox init failed"),
      "error",
    );
  });

  it("unsupported platform → sandbox off, tool guard on, warning notify", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    isSupportedPlatformMock.mockReturnValue(false);

    const mock = setup();
    const ctx = makeCtx({ cwd: tmp });
    await mock.invoke.sessionStart(ctx);

    expect(initializeMock).not.toHaveBeenCalled();
    const state = __testing__.state();
    expect(state.sandboxEnabled).toBe(false);
    expect(state.toolGuardEnabled).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("OS sandbox not supported"),
      "warning",
    );
  });
});

describe("user_bash — fail-closed", () => {
  // A fake EventEmitter-like child that we control from within tests.
  function fakeChild() {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const emit = (ev: string, ...a: unknown[]) => listeners[ev]?.forEach((fn) => fn(...a));
    const child = {
      pid: 1234,
      stdout: { on: vi.fn((ev: string, fn: (...a: unknown[]) => void) => ((listeners[`stdout:${ev}`] ??= []).push(fn))) },
      stderr: { on: vi.fn((ev: string, fn: (...a: unknown[]) => void) => ((listeners[`stderr:${ev}`] ??= []).push(fn))) },
      on: vi.fn((ev: string, fn: (...a: unknown[]) => void) => ((listeners[ev] ??= []).push(fn))),
      kill: vi.fn(),
    };
    return { child, emit };
  }

  it("happy path: returns operations whose exec invokes wrapWithSandbox + spawn(bash, -c, wrapped)", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const result = (await mock.invoke.userBash({}, makeCtx())) as { operations: { exec: (...a: unknown[]) => Promise<unknown> } };
    expect(result.operations).toBeDefined();

    const { child, emit } = fakeChild();
    spawnMock.mockReturnValueOnce(child);

    const onData = vi.fn();
    const execPromise = result.operations.exec("echo hi", tmp, { onData });

    // exec is async with an internal `await wrapWithSandbox(...)`. Let those
    // microtasks flush before asserting that spawn was called.
    await new Promise((r) => setImmediate(r));

    expect(wrapWithSandboxMock).toHaveBeenCalledWith("echo hi");
    expect(spawnMock).toHaveBeenCalledWith(
      "bash",
      ["-c", "WRAPPED(echo hi)"],
      expect.objectContaining({ cwd: tmp }),
    );

    emit("close", 0);
    await expect(execPromise).resolves.toEqual({ exitCode: 0 });
  });

  it("sandboxFailed: returns BashResult fail-closed (does NOT call wrapWithSandbox)", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    initializeMock.mockRejectedValue(new Error("bwrap missing"));

    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const result = (await mock.invoke.userBash({}, makeCtx())) as { result?: { exitCode: number; output: string } };
    expect(result.result).toBeDefined();
    expect(result.result?.exitCode).toBe(1);
    expect(result.result?.output).toMatch(/sandbox.*failed/i);
    expect(wrapWithSandboxMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("--no-sandbox: returns undefined (pi runs bash unsandboxed)", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup({ noSandbox: true });
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const result = await mock.invoke.userBash({}, makeCtx());
    expect(result).toBeUndefined();
  });

  it("AbortSignal aborted mid-exec → child SIGKILLed, promise rejects 'aborted'", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const result = (await mock.invoke.userBash({}, makeCtx())) as { operations: { exec: (...a: unknown[]) => Promise<unknown> } };
    const { child, emit } = fakeChild();
    spawnMock.mockReturnValueOnce(child);

    const ac = new AbortController();
    const execPromise = result.operations.exec("sleep 100", tmp, {
      onData: vi.fn(),
      signal: ac.signal,
    });

    // Wait for spawn + listener registration to complete.
    await new Promise((r) => setImmediate(r));
    ac.abort(); // sets ac.signal.aborted = true natively
    emit("close", null);

    await expect(execPromise).rejects.toThrow("aborted");
  });

  it("timeout fires → child SIGKILLed, promise rejects 'timeout:<n>'", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const result = (await mock.invoke.userBash({}, makeCtx())) as { operations: { exec: (...a: unknown[]) => Promise<unknown> } };
    const { child, emit } = fakeChild();
    spawnMock.mockReturnValueOnce(child);

    const execPromise = result.operations.exec("sleep 100", tmp, {
      onData: vi.fn(),
      timeout: 0.001, // 1 ms
    });

    // Let timeout fire (1ms) and exec body run (microtasks).
    await new Promise((r) => setTimeout(r, 25));
    emit("close", null);

    await expect(execPromise).rejects.toThrow(/timeout/);
  });
});

describe("tool_call — read guard", () => {
  it("blocks read under denyRead (path resolved against actual homedir)", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    // DEFAULT_CONFIG denies "~/.ssh" — matched against the real homedir.
    const { homedir } = await import("node:os");
    const target = join(homedir(), ".ssh", "id_ed25519");

    const ctx = makeCtx({ cwd: tmp });
    const result = (await mock.invoke.toolCall(
      { toolName: "read", input: { path: target } },
      ctx,
    )) as { block?: boolean; reason?: string };

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(".ssh");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Sandbox blocked read"),
      "warning",
    );
  });

  it("passes through allowed read", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const result = await mock.invoke.toolCall(
      { toolName: "read", input: { path: join(tmp, "src/foo.ts") } },
      makeCtx({ cwd: tmp }),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when toolGuardEnabled is false (--no-sandbox)", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup({ noSandbox: true });
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const { homedir } = await import("node:os");
    const result = await mock.invoke.toolCall(
      { toolName: "read", input: { path: join(homedir(), ".ssh", "id_ed25519") } },
      makeCtx(),
    );
    expect(result).toBeUndefined();
  });
});

describe("tool_call — write guard", () => {
  it("hard-blocks write to denyWrite pattern (no prompt even with UI)", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp });
    const result = (await mock.invoke.toolCall(
      { toolName: "write", input: { path: join(tmp, ".env.local") } },
      ctx,
    )) as { block?: boolean; reason?: string };

    expect(result.block).toBe(true);
    expect(result.reason).toContain("matches restricted pattern");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("prompts on write outside allowWrite when UI available; 'session' allows + persists in-memory", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp });
    ctx.ui.select.mockResolvedValueOnce("Allow for this session only");

    const r1 = await mock.invoke.toolCall(
      { toolName: "write", input: { path: "/private/area/file.txt" } },
      ctx,
    );
    expect(r1).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenCalledOnce();

    // Subsequent write to same path: no prompt this session.
    const r2 = await mock.invoke.toolCall(
      { toolName: "write", input: { path: "/private/area/file.txt" } },
      ctx,
    );
    expect(r2).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenCalledOnce();
  });

  it("'project' choice persists path into project sandbox.json", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp });
    ctx.ui.select.mockResolvedValueOnce("Allow for this project");

    await mock.invoke.toolCall(
      { toolName: "write", input: { path: "/private/area/file.txt" } },
      ctx,
    );

    const projectFile = join(tmp, ".pi-test", "sandbox.json");
    const parsed = JSON.parse(readFileSync(projectFile, "utf-8"));
    expect(parsed.filesystem.allowWrite).toContain("/private/area/file.txt");
    expect(updateConfigMock).toHaveBeenCalled();
  });

  it("'global' choice persists path into user sandbox.json (getAgentDir-based)", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp });
    ctx.ui.select.mockResolvedValueOnce("Allow for all projects");

    await mock.invoke.toolCall(
      { toolName: "write", input: { path: "/global/area/file.txt" } },
      ctx,
    );

    const userFile = join(tmp, "sandbox.json");
    const parsed = JSON.parse(readFileSync(userFile, "utf-8"));
    expect(parsed.filesystem.allowWrite).toContain("/global/area/file.txt");
  });

  it("'abort' choice → block:true", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp });
    ctx.ui.select.mockResolvedValueOnce("Abort (keep blocked)");

    const r = (await mock.invoke.toolCall(
      { toolName: "write", input: { path: "/no/area/file.txt" } },
      ctx,
    )) as { block?: boolean };
    expect(r.block).toBe(true);
  });

  it("no UI: hard-block without prompting", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp, hasUI: false });
    const r = (await mock.invoke.toolCall(
      { toolName: "write", input: { path: "/no-ui/file.txt" } },
      ctx,
    )) as { block?: boolean };

    expect(r.block).toBe(true);
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});

describe("session_shutdown", () => {
  it("calls SandboxManager.reset when initialized", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    await mock.invoke.sessionShutdown();
    expect(resetMock).toHaveBeenCalled();
  });

  it("swallows errors from reset()", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    resetMock.mockRejectedValueOnce(new Error("cleanup failed"));

    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    await expect(mock.invoke.sessionShutdown()).resolves.toBeUndefined();
  });

  it("does NOT call reset when sandbox was never initialized (e.g. --no-sandbox)", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup({ noSandbox: true });
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    await mock.invoke.sessionShutdown();
    expect(resetMock).not.toHaveBeenCalled();
  });
});

describe("/sandbox slash command", () => {
  it("status shows enabled state + counts", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp });
    await mock.invoke.sandboxCommand("status", ctx);

    const msg = (ctx.ui.notify.mock.calls[0]?.[0] ?? "") as string;
    expect(msg).toContain("OS sandbox: enabled");
    expect(msg).toContain("Tool guard: enabled");
  });

  it("status reports FAILED when init failed", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    initializeMock.mockRejectedValue(new Error("bwrap missing"));

    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp });
    await mock.invoke.sandboxCommand("status", ctx);
    const msg = (ctx.ui.notify.mock.calls[0]?.[0] ?? "") as string;
    expect(msg).toContain("FAILED");
  });

  it("show prints effective merged config as JSON", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp });
    await mock.invoke.sandboxCommand("show", ctx);
    const msg = (ctx.ui.notify.mock.calls[0]?.[0] ?? "") as string;
    expect(msg).toContain("api.anthropic.com");
    expect(() => JSON.parse(msg)).not.toThrow();
  });

  it("validate reports OK / INVALID per layer", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    writeFileSync(join(tmp, "sandbox.json"), "{ broken json");
    mkdirSync(join(tmp, ".pi-test"));
    writeFileSync(join(tmp, ".pi-test", "sandbox.json"), JSON.stringify({ enabled: true }));

    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp });
    await mock.invoke.sandboxCommand("validate", ctx);
    const msg = (ctx.ui.notify.mock.calls[0]?.[0] ?? "") as string;
    expect(msg).toContain("user");
    expect(msg).toContain("INVALID");
    expect(msg).toContain("project");
    expect(msg).toContain("OK");
  });

  it("reload re-reads config and calls SandboxManager.updateConfig", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    // Now write a project config and reload.
    mkdirSync(join(tmp, ".pi-test"));
    writeFileSync(
      join(tmp, ".pi-test", "sandbox.json"),
      JSON.stringify({
        network: { allowedDomains: ["after-reload.com"], deniedDomains: [] },
      }),
    );

    const ctx = makeCtx({ cwd: tmp });
    await mock.invoke.sandboxCommand("reload", ctx);

    expect(updateConfigMock).toHaveBeenCalled();
    const lastCall = updateConfigMock.mock.calls.at(-1);
    expect(lastCall?.[0].network.allowedDomains).toEqual(["after-reload.com"]);
  });

  it("unknown subcommand emits a warning", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/h/.pi-test");
    const mock = setup();
    await mock.invoke.sessionStart(makeCtx({ cwd: tmp }));

    const ctx = makeCtx({ cwd: tmp });
    await mock.invoke.sandboxCommand("nonsense", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/Unknown subcommand/),
      "warning",
    );
  });
});
