import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentWorkspace, getAgentWorkspacePaths } from "./workspace.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "workspace-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createAgentWorkspace", () => {
  it("creates the workspace directory and returns paths", () => {
    const paths = createAgentWorkspace(tmpDir, "researcher");
    expect(existsSync(paths.root)).toBe(true);
    expect(paths.root).toBe(join(tmpDir, "workspaces", "researcher"));
    expect(paths.sessionFile).toBe(join(tmpDir, "workspaces", "researcher", "session.json"));
    expect(paths.notesFile).toBe(join(tmpDir, "workspaces", "researcher", "notes.md"));
    expect(paths.outputFile).toBe(join(tmpDir, "workspaces", "researcher", "output.md"));
  });

  it("is idempotent", () => {
    const paths1 = createAgentWorkspace(tmpDir, "agent-a");
    const paths2 = createAgentWorkspace(tmpDir, "agent-a");
    expect(paths1).toEqual(paths2);
  });
});

describe("getAgentWorkspacePaths", () => {
  it("returns paths without creating directories", () => {
    const paths = getAgentWorkspacePaths(tmpDir, "phantom");
    expect(existsSync(paths.root)).toBe(false);
    expect(paths.root).toBe(join(tmpDir, "workspaces", "phantom"));
  });
});

describe("instanceId suffix", () => {
  it("createAgentWorkspace with instanceId uses agent-instance dir name", () => {
    const paths = createAgentWorkspace(tmpDir, "researcher", 2);
    expect(paths.root).toMatch(/workspaces[/\\]researcher-2$/);
    expect(paths.sessionFile).toMatch(/researcher-2[/\\]session\.json$/);
  });

  it("getAgentWorkspacePaths with instanceId uses agent-instance dir name", () => {
    const paths = getAgentWorkspacePaths(tmpDir, "researcher", 1);
    expect(paths.root).toMatch(/workspaces[/\\]researcher-1$/);
  });

  it("omitting instanceId preserves original path (no suffix)", () => {
    const paths = getAgentWorkspacePaths(tmpDir, "researcher");
    expect(paths.root).toMatch(/workspaces[/\\]researcher$/);
    // should not have a numeric suffix at all
    expect(paths.root).not.toMatch(/researcher-\d+$/);
  });
});
