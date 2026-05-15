// Tests for spawnAgent — exercises the Promise-based process orchestration.
//
// child_process.spawn is mocked so no real `pi` binary is launched. Tests
// control the mock's stdout/stderr/event callbacks directly and assert on the
// resolved AgentRunResult.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock spawn ────────────────────────────────────────────────────────────────
// vi.hoisted ensures the mock factory runs before imports so the module
// under test picks up the mocked version.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  type: "ChildProcess", // kept for type compatibility
}));

import { spawnAgent } from "./agent-runner.js";
import type { AgentDefinition, AgentWorkspacePaths } from "./types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    description: "A test agent",
    systemPrompt: "You are a test agent.",
    filePath: "/fake/path.md",
    ...overrides,
  };
}

function makeWorkspace(root: string): AgentWorkspacePaths {
  return {
    root,
    sessionFile: join(root, "session.json"),
    notesFile: join(root, "notes.md"),
    outputFile: join(root, "output.md"),
  };
}

/**
 * Build a minimal mock ChildProcess that exposes stdout/stderr/event emitters.
 * Return helpers to simulate stdout data and process exit.
 */
function makeMockProc() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stdout.setEncoding = vi.fn();

  const stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr.setEncoding = vi.fn();

  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn();
  proc.pid = 12345;

  spawnMock.mockReturnValue(proc);

  return {
    proc,
    emitStdout: (data: string) => stdout.emit("data", data),
    emitStderr: (data: string) => stderr.emit("data", data),
    close: (code: number | null) => proc.emit("close", code),
    emitError: (err: Error) => proc.emit("error", err),
  };
}

let tmpDir: string;
let workspace: AgentWorkspacePaths;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-spawn-test-"));
  workspace = makeWorkspace(tmpDir);
  spawnMock.mockReset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── basic process lifecycle ───────────────────────────────────────────────────

describe("spawnAgent — basic lifecycle", () => {
  it("resolves with exitCode 0 and empty output when no stdout emitted", async () => {
    const { close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    close(0);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("resolves with exitCode 1 when process exits non-zero", async () => {
    const { close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    close(2);
    const result = await promise;
    expect(result.exitCode).toBe(2);
  });

  it("uses exit code 1 when close emits null", async () => {
    const { close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    close(null);
    const result = await promise;
    expect(result.exitCode).toBe(1);
  });

  it("resolves with output from message_update text_delta events", async () => {
    const { emitStdout, close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    // Emit JSON events as the real pi process would.
    emitStdout(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      }) + "\n",
    );
    emitStdout(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "world" },
      }) + "\n",
    );

    close(0);
    const result = await promise;
    expect(result.output).toBe("Hello world");
  });

  it("calls onProgress with the last non-empty line of accumulated output", async () => {
    const { emitStdout, close } = makeMockProc();
    const progress: string[] = [];

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
      onProgress: (line) => progress.push(line),
    });

    emitStdout(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Line 1\nLine 2" },
      }) + "\n",
    );
    close(0);
    await promise;

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe("Line 2");
  });

  it("ignores non-JSON lines in stdout without throwing", async () => {
    const { emitStdout, close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    emitStdout("not-json-at-all\n");
    emitStdout("also not json\n");
    close(0);

    const result = await promise;
    expect(result.output).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("ignores message_update events that are not text_delta type", async () => {
    const { emitStdout, close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    emitStdout(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "tool_use", id: "123" },
      }) + "\n",
    );
    close(0);
    const result = await promise;
    expect(result.output).toBe("");
  });

  it("ignores unknown event types in stdout", async () => {
    const { emitStdout, close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    emitStdout(JSON.stringify({ type: "session_start" }) + "\n");
    close(0);
    const result = await promise;
    expect(result.output).toBe("");
  });
});

// ── spawn error handling ──────────────────────────────────────────────────────

describe("spawnAgent — spawn errors", () => {
  it("resolves with error output when spawn() throws synchronously", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("pi not found in PATH");
    });

    const result = await spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error spawning agent");
    expect(result.output).toContain("pi not found in PATH");
    expect(result.elapsedMs).toBe(0);
  });

  it("resolves with error output when proc emits 'error' event", async () => {
    const { emitError } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    emitError(new Error("ENOENT spawn failed"));
    const result = await promise;

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error spawning agent");
    expect(result.output).toContain("ENOENT spawn failed");
  });
});

// ── abort signal ─────────────────────────────────────────────────────────────

describe("spawnAgent — abort signal", () => {
  it("calls proc.kill('SIGTERM') when signal is aborted before close", async () => {
    const { proc, close } = makeMockProc();

    const controller = new AbortController();
    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
      signal: controller.signal,
    });

    controller.abort();
    close(0);
    await promise;

    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("resolves normally after abort + close", async () => {
    const { close } = makeMockProc();
    const controller = new AbortController();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
      signal: controller.signal,
    });

    controller.abort();
    close(1);
    const result = await promise;

    expect(result.exitCode).toBe(1);
  });
});

// ── remaining buffer on close ─────────────────────────────────────────────────

describe("spawnAgent — remaining buffer on close", () => {
  it("processes a partial JSON line that sits in buffer at close time", async () => {
    const { emitStdout, close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    // Emit the JSON without a trailing newline — it ends up in `buffer`.
    const jsonLine = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "buffered text" },
    });
    emitStdout(jsonLine); // no trailing \n

    close(0);
    const result = await promise;
    expect(result.output).toBe("buffered text");
  });

  it("ignores non-JSON content left in buffer at close", async () => {
    const { emitStdout, close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    emitStdout("partial-line-no-newline");
    close(0);
    const result = await promise;
    expect(result.output).toBe("");
  });
});

// ── env vars ──────────────────────────────────────────────────────────────────

describe("spawnAgent — env variables", () => {
  it("sets PI_AGENT_TEAMS_CHILD=1 in child process env", async () => {
    const { close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    close(0);
    await promise;

    const spawnCallEnv = spawnMock.mock.calls[0][2].env;
    expect(spawnCallEnv.PI_AGENT_TEAMS_CHILD).toBe("1");
  });

  it("sets PI_TODO_PATH to workspace.root in child process env", async () => {
    const { close } = makeMockProc();

    const promise = spawnAgent({
      agent: makeAgent(),
      task: "do something",
      workspace,
      cwd: tmpDir,
    });

    close(0);
    await promise;

    const spawnCallEnv = spawnMock.mock.calls[0][2].env;
    expect(spawnCallEnv.PI_TODO_PATH).toBe(workspace.root);
  });
});
