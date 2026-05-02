import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRun,
  loadRun,
  updateRunStatus,
  runExists,
  runDir,
} from "./run-manager.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "run-manager-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createRun", () => {
  it("creates a run directory with run.json", () => {
    const state = createRun(tmpDir, "my-team", "Build a feature");
    expect(state.runId).toMatch(/^run-\d+-[a-f0-9]+$/);
    expect(state.team).toBe("my-team");
    expect(state.goal).toBe("Build a feature");
    expect(state.status).toBe("running");
    expect(runExists(tmpDir, "my-team", state.runId)).toBe(true);
  });
});

describe("loadRun", () => {
  it("loads a previously created run", () => {
    const created = createRun(tmpDir, "team-a", "Do stuff");
    const loaded = loadRun(tmpDir, "team-a", created.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(created.runId);
    expect(loaded!.goal).toBe("Do stuff");
  });

  it("returns null for non-existent run", () => {
    expect(loadRun(tmpDir, "team-a", "run-nonexistent")).toBeNull();
  });
});

describe("updateRunStatus", () => {
  it("updates status and updatedAt", () => {
    const created = createRun(tmpDir, "team-a", "Goal");
    const updated = updateRunStatus(tmpDir, "team-a", created.runId, "completed");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("completed");
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    );

    // Verify persisted
    const reloaded = loadRun(tmpDir, "team-a", created.runId);
    expect(reloaded!.status).toBe("completed");
  });

  it("returns null for non-existent run", () => {
    expect(updateRunStatus(tmpDir, "team-a", "nope", "failed")).toBeNull();
  });
});

describe("runDir", () => {
  it("nests under team name", () => {
    const dir = runDir(tmpDir, "my-team", "run-123");
    expect(dir).toBe(join(tmpDir, ".pi", "agent-teams", "runs", "my-team", "run-123"));
  });
});
