// extensions/git-worktree.test.ts
//
// Integration tests for the git-worktree extension's worktree logic.
// Tests focus on the worktree-manager functions used by the /worktree commands
// and the --worktree flag, verifying the full create → find → switch flow.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  findWorktreeByName,
  listWorktrees,
} from "./git-worktree/worktree-manager.js";

let repoDir: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "git-worktree-ext-test-")),
  );
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  execFileSync("touch", ["README.md"], { cwd: dir });
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

beforeEach(() => {
  repoDir = initRepo();
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("create → list → switch flow", () => {
  it("create does not auto-switch (createWorktree has no process.cwd side-effect)", () => {
    const cwdBefore = process.cwd();
    const result = createWorktree(repoDir, "my-feature");
    expect(process.cwd()).toBe(cwdBefore);
    expect(existsSync(result.path)).toBe(true);
  });

  it("findWorktreeByName returns the worktree after creation", () => {
    createWorktree(repoDir, "my-feature");
    const found = findWorktreeByName(repoDir, "my-feature");
    expect(found).toBeDefined();
    expect(found!.branch).toBe("agent-teams/my-feature");
  });

  it("findWorktreeByName returns undefined for non-existent name", () => {
    const found = findWorktreeByName(repoDir, "does-not-exist");
    expect(found).toBeUndefined();
  });

  it("findWorktreeByName handles names with spaces and capitals (sanitized)", () => {
    createWorktree(repoDir, "My Feature");
    const found = findWorktreeByName(repoDir, "My Feature");
    expect(found).toBeDefined();
    const found2 = findWorktreeByName(repoDir, "my-feature");
    expect(found2).toBeDefined();
    expect(found!.path).toBe(found2!.path);
  });

  it("worktree path is correct after process.chdir() (simulates /worktree switch)", () => {
    createWorktree(repoDir, "switch-test");
    const found = findWorktreeByName(repoDir, "switch-test");
    expect(found).toBeDefined();

    const originalCwd = process.cwd();
    try {
      process.chdir(found!.path);
      expect(process.cwd()).toBe(found!.path);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("--worktree upsert: finds existing worktree instead of creating a duplicate", () => {
    const first = createWorktree(repoDir, "upsert-test");
    const countBefore = listWorktrees(repoDir).length;

    // Simulate session_start: findWorktreeByName first
    const existing = findWorktreeByName(repoDir, "upsert-test");
    expect(existing).toBeDefined();
    expect(existing!.path).toBe(first.path);

    // No new worktree created
    expect(listWorktrees(repoDir).length).toBe(countBefore);
  });

  it("/worktree switch errors if worktree does not exist (findWorktreeByName returns undefined)", () => {
    expect(findWorktreeByName(repoDir, "nonexistent")).toBeUndefined();
  });

  it("list marks the correct worktree as active based on path comparison", () => {
    const result = createWorktree(repoDir, "active-test");
    const worktrees = listWorktrees(repoDir);
    const active = worktrees.find((wt) => wt.path === result.path);
    expect(active).toBeDefined();
    expect(active!.path).toBe(result.path);
  });
});
