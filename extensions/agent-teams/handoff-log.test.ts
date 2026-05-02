import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHandoff, loadHandoffs } from "./handoff-log.js";

let runDirPath: string;

beforeEach(() => {
  runDirPath = mkdtempSync(join(tmpdir(), "handoff-log-test-"));
  mkdirSync(runDirPath, { recursive: true });
});

afterEach(() => {
  rmSync(runDirPath, { recursive: true, force: true });
});

describe("appendHandoff", () => {
  it("appends to NDJSON and creates markdown", () => {
    const entry = appendHandoff(runDirPath, {
      type: "dispatch",
      runId: "run-123",
      fromAgent: "orchestrator",
      toAgent: "researcher",
      taskId: "task-1",
      summary: "Research the auth patterns",
    });

    expect(entry.seq).toBe(1);
    expect(entry.type).toBe("dispatch");
    expect(entry.fromAgent).toBe("orchestrator");

    // NDJSON exists
    expect(existsSync(join(runDirPath, "handoffs.ndjson"))).toBe(true);

    // Markdown exists
    const md = readFileSync(join(runDirPath, "handoffs.md"), "utf-8");
    expect(md).toContain("# Handoff Log — run-123");
    expect(md).toContain("orchestrator → researcher");
    expect(md).toContain("Research the auth patterns");
  });

  it("auto-increments sequence numbers", () => {
    appendHandoff(runDirPath, {
      type: "dispatch",
      runId: "run-123",
      fromAgent: "orchestrator",
      toAgent: "researcher",
      taskId: "task-1",
      summary: "Go research",
    });

    const entry2 = appendHandoff(runDirPath, {
      type: "completion",
      runId: "run-123",
      fromAgent: "researcher",
      toAgent: "orchestrator",
      taskId: "task-1",
      summary: "Done researching",
      elapsedMs: 45000,
    });

    expect(entry2.seq).toBe(2);
  });

  it("includes artifacts and elapsed time in markdown", () => {
    appendHandoff(runDirPath, {
      type: "completion",
      runId: "run-123",
      fromAgent: "researcher",
      toAgent: "orchestrator",
      taskId: "task-1",
      summary: "Found patterns",
      artifacts: ["workspaces/researcher/notes.md"],
      elapsedMs: 90000,
    });

    const md = readFileSync(join(runDirPath, "handoffs.md"), "utf-8");
    expect(md).toContain("📎 Artifacts: workspaces/researcher/notes.md");
    expect(md).toContain("(1m 30s)");
  });
});

describe("loadHandoffs", () => {
  it("returns empty array when no log exists", () => {
    expect(loadHandoffs(runDirPath)).toEqual([]);
  });

  it("loads all entries from NDJSON", () => {
    appendHandoff(runDirPath, {
      type: "dispatch",
      runId: "run-1",
      fromAgent: "a",
      toAgent: "b",
      taskId: "t1",
      summary: "First",
    });
    appendHandoff(runDirPath, {
      type: "completion",
      runId: "run-1",
      fromAgent: "b",
      toAgent: "a",
      taskId: "t1",
      summary: "Second",
    });

    const entries = loadHandoffs(runDirPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].summary).toBe("First");
    expect(entries[1].summary).toBe("Second");
  });
});
