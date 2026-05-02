// Git Worktree — manage git worktrees for isolated agent workspaces.
//
// Provides create/remove/list operations and optional node_modules symlinking.

import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the worktree. */
  path: string;
  /** Branch name. */
  branch: string;
  /** HEAD commit hash. */
  head: string;
  /** Whether this is the main worktree. */
  isMain: boolean;
}

export interface CreateWorktreeResult {
  /** Absolute path to the created worktree. */
  path: string;
  /** Branch name. */
  branch: string;
  /** Whether node_modules was symlinked. */
  nodeModulesLinked: boolean;
}

/**
 * Run a git command and return trimmed stdout.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Find the repository root from a given directory.
 */
export function findGitRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

/**
 * Sanitize a string for use in a branch name.
 */
function sanitizeBranchPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "branch";
}

/**
 * Create a git worktree with a new branch.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param name     - A human-friendly name used to derive the branch and directory.
 * @param opts     - Additional options.
 * @returns Result including the worktree path and branch name.
 */
export function createWorktree(
  repoRoot: string,
  name: string,
  opts?: {
    /** Base directory for worktrees. Defaults to `<repoRoot>/.worktrees/`. */
    baseDir?: string;
    /** Whether to symlink node_modules from the repo root. Default: true. */
    linkNodeModules?: boolean;
    /** Base branch/ref to branch from. Default: HEAD. */
    baseBranch?: string;
  },
): CreateWorktreeResult {
  const baseDir = opts?.baseDir ?? join(repoRoot, ".worktrees");
  const branchName = `agent-teams/${sanitizeBranchPart(name)}`;
  const worktreePath = resolve(baseDir, sanitizeBranchPart(name));
  const baseBranch = opts?.baseBranch ?? "HEAD";

  // Create the worktree with a new branch.
  git(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseBranch]);

  // Optionally symlink node_modules.
  let nodeModulesLinked = false;
  if (opts?.linkNodeModules !== false) {
    nodeModulesLinked = linkNodeModules(repoRoot, worktreePath);
  }

  return {
    path: worktreePath,
    branch: branchName,
    nodeModulesLinked,
  };
}

/**
 * Remove a git worktree and its branch.
 *
 * @param repoRoot     - Absolute path to the repository root.
 * @param worktreePath - Absolute path to the worktree to remove.
 * @param opts         - Additional options.
 */
export function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  opts?: {
    /** Force removal even if there are changes. Default: false. */
    force?: boolean;
    /** Also delete the branch. Default: true. */
    deleteBranch?: boolean;
  },
): void {
  // Get the branch name before removing the worktree.
  let branchToDelete: string | undefined;
  if (opts?.deleteBranch !== false) {
    try {
      branchToDelete = git(worktreePath, ["branch", "--show-current"]);
    } catch {
      // Worktree may already be gone.
    }
  }

  const removeArgs = ["worktree", "remove", worktreePath];
  if (opts?.force) removeArgs.push("--force");
  git(repoRoot, removeArgs);

  // Delete the branch if requested and it was found.
  if (branchToDelete) {
    try {
      git(repoRoot, ["branch", "-D", branchToDelete]);
    } catch {
      // Branch may already be gone or be the current branch.
    }
  }
}

/**
 * List all worktrees for a repository.
 */
export function listWorktrees(repoRoot: string): WorktreeInfo[] {
  const output = git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!output.trim()) return [];

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push(current as WorktreeInfo);
      }
      current = { path: line.slice("worktree ".length), isMain: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      // refs/heads/branch-name → branch-name
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare" || line === "") {
      if (current.path && !current.branch) {
        current.branch = "(detached)";
        current.isMain = true;
      }
    }
  }

  if (current.path) {
    worktrees.push(current as WorktreeInfo);
  }

  // The first worktree is the main one.
  if (worktrees.length > 0) {
    worktrees[0].isMain = true;
  }

  return worktrees;
}

/**
 * Symlink node_modules from the repo root into a worktree.
 * Returns true if the symlink was created.
 */
export function linkNodeModules(
  repoRoot: string,
  worktreePath: string,
): boolean {
  const source = join(repoRoot, "node_modules");
  const target = join(worktreePath, "node_modules");

  if (!existsSync(source)) return false;
  if (existsSync(target)) return false;

  try {
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(source, target, linkType);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the repository working tree is clean (no uncommitted changes).
 */
export function isCleanWorkingTree(repoRoot: string): boolean {
  const status = git(repoRoot, ["status", "--porcelain"]);
  return status.trim() === "";
}
