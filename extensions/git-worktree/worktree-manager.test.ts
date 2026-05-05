import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  findGitRoot,
  findWorktreeByName,
  isCleanWorkingTree,
  linkNodeModules,
  listWorktrees,
  removeWorktree,
} from "./worktree-manager.js";

let repoDir: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(): string {
  // realpathSync resolves macOS /var → /private/var so git's output matches.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-test-")));
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  // Need at least one commit for worktrees to work.
  execFileSync("touch", ["README.md"], { cwd: dir });
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

beforeEach(() => {
  repoDir = initRepo();
});

afterEach(() => {
  // Clean up worktrees before removing the repo dir.
  try {
    const worktrees = listWorktrees(repoDir);
    for (const wt of worktrees) {
      if (!wt.isMain) {
        try {
          removeWorktree(repoDir, wt.path, { force: true });
        } catch {
          // Best effort cleanup.
        }
      }
    }
  } catch {
    // Repo may already be gone.
  }
  rmSync(repoDir, { recursive: true, force: true });
});

describe("findGitRoot", () => {
  it("returns the repository root", () => {
    expect(findGitRoot(repoDir)).toBe(repoDir);
  });

  it("throws for non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "non-git-"));
    expect(() => findGitRoot(nonGit)).toThrow();
    rmSync(nonGit, { recursive: true, force: true });
  });
});

describe("isCleanWorkingTree", () => {
  it("returns true for clean repo", () => {
    expect(isCleanWorkingTree(repoDir)).toBe(true);
  });

  it("returns false for dirty repo", () => {
    execFileSync("touch", ["dirty-file.txt"], { cwd: repoDir });
    expect(isCleanWorkingTree(repoDir)).toBe(false);
  });
});

describe("createWorktree / removeWorktree", () => {
  it("creates a worktree with a new branch", () => {
    const result = createWorktree(repoDir, "feature-test");
    expect(result.branch).toBe("agent-teams/feature-test");
    expect(existsSync(result.path)).toBe(true);

    // Verify the branch exists.
    const branches = git(repoDir, ["branch", "--list"]);
    expect(branches).toContain("agent-teams/feature-test");
  });

  it("removes a worktree and its branch", () => {
    const result = createWorktree(repoDir, "to-remove");
    expect(existsSync(result.path)).toBe(true);

    removeWorktree(repoDir, result.path, { force: true });
    expect(existsSync(result.path)).toBe(false);

    const branches = git(repoDir, ["branch", "--list"]);
    expect(branches).not.toContain("agent-teams/to-remove");
  });
});

describe("listWorktrees", () => {
  it("lists the main worktree", () => {
    const worktrees = listWorktrees(repoDir);
    expect(worktrees.length).toBeGreaterThanOrEqual(1);
    expect(worktrees[0].isMain).toBe(true);
    expect(worktrees[0].branch).toBe("main");
  });

  it("lists additional worktrees", () => {
    createWorktree(repoDir, "extra");
    const worktrees = listWorktrees(repoDir);
    expect(worktrees).toHaveLength(2);
    const extra = worktrees.find((wt) => !wt.isMain);
    expect(extra).toBeDefined();
    expect(extra!.branch).toBe("agent-teams/extra");
  });
});

describe("linkNodeModules", () => {
  it("returns false when source node_modules does not exist", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "link-test-"));
    expect(linkNodeModules(repoDir, targetDir)).toBe(false);
    rmSync(targetDir, { recursive: true, force: true });
  });
});

describe("findWorktreeByName", () => {
  it("returns undefined when the named worktree does not exist", () => {
    const found = findWorktreeByName(repoDir, "nonexistent");
    expect(found).toBeUndefined();
  });

  it("returns the worktree when found by exact name", () => {
    createWorktree(repoDir, "my-feature");
    const found = findWorktreeByName(repoDir, "my-feature");
    expect(found).toBeDefined();
    expect(found!.branch).toBe("agent-teams/my-feature");
  });

  it("returns undefined for a non-existent name even when worktrees exist", () => {
    createWorktree(repoDir, "existing");
    const found = findWorktreeByName(repoDir, "not-existing");
    expect(found).toBeUndefined();
  });

  it("handles names with spaces and capitals (sanitized to match directory)", () => {
    createWorktree(repoDir, "My Feature");
    // "My Feature" sanitizes to "my-feature"
    const found = findWorktreeByName(repoDir, "My Feature");
    expect(found).toBeDefined();
    const found2 = findWorktreeByName(repoDir, "my-feature");
    expect(found2).toBeDefined();
    expect(found!.path).toBe(found2!.path);
  });

  it("finds the correct worktree among multiple worktrees", () => {
    createWorktree(repoDir, "alpha");
    createWorktree(repoDir, "beta");
    const found = findWorktreeByName(repoDir, "beta");
    expect(found).toBeDefined();
    expect(found!.branch).toBe("agent-teams/beta");
    const notFound = findWorktreeByName(repoDir, "gamma");
    expect(notFound).toBeUndefined();
  });
});
