// Git Worktree — standalone extension for managing git worktrees.
//
// Provides the `/worktree` command for interactive use and exports
// functions for programmatic use by other extensions (e.g. agent-teams).
//
// Usage: pi -e extensions/git-worktree.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createWorktree,
  findGitRoot,
  findWorktreeByName,
  isCleanWorkingTree,
  listWorktrees,
  removeWorktree,
  type CreateWorktreeResult,
} from "./git-worktree/worktree-manager.js";

// Re-export for programmatic use by other extensions.
export {
  createWorktree,
  findGitRoot,
  findWorktreeByName,
  isCleanWorkingTree,
  linkNodeModules,
  listWorktrees,
  removeWorktree,
} from "./git-worktree/worktree-manager.js";

// Active working directory override — updated when switching worktrees.
let activeCwd: string | undefined;

function getActiveCwd(fallback: string): string {
  return activeCwd ?? fallback;
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("worktree", {
    description:
      "Git worktree management: /worktree list | create <name> | switch <name> | remove <path>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || "list";

      let repoRoot: string;
      try {
        repoRoot = findGitRoot(getActiveCwd(ctx.cwd));
      } catch {
        ctx.ui.notify(
          "Not a git repository. Git worktrees require a git repo.",
          "error",
        );
        return;
      }

      switch (sub) {
        case "list": {
          const worktrees = listWorktrees(repoRoot);
          if (worktrees.length === 0) {
            ctx.ui.notify("No worktrees found.", "info");
            return;
          }
          const lines = worktrees.map((wt) => {
            const isActive = wt.path === activeCwd;
            const marker = [
              wt.isMain ? "(main)" : "",
              isActive ? "(active)" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const markerStr = marker ? ` ${marker}` : "";
            return `${wt.branch}${markerStr}\n  ${wt.path}\n  HEAD: ${wt.head?.slice(0, 8) ?? "unknown"}`;
          });
          ctx.ui.notify(lines.join("\n\n"), "info");
          return;
        }

        case "create": {
          const name = parts.slice(1).join("-") || "";
          if (!name) {
            ctx.ui.notify(
              "Usage: /worktree create <name>",
              "warning",
            );
            return;
          }

          if (!isCleanWorkingTree(repoRoot)) {
            ctx.ui.notify(
              "Working tree has uncommitted changes. Commit or stash before creating a worktree.",
              "warning",
            );
            return;
          }

          let result: CreateWorktreeResult;
          try {
            result = createWorktree(repoRoot, name);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Failed to create worktree: ${msg}`, "error");
            return;
          }

          ctx.ui.notify(
            `Worktree created:\n  Branch: ${result.branch}\n  Path: ${result.path}\n  node_modules linked: ${result.nodeModulesLinked}\n\nRun \`/worktree switch ${name}\` to switch to it.`,
            "info",
          );
          return;
        }

        case "remove": {
          const targetPath = parts[1] || "";
          if (!targetPath) {
            ctx.ui.notify("Usage: /worktree remove <path>", "warning");
            return;
          }

          try {
            removeWorktree(repoRoot, targetPath, { force: true });
            ctx.ui.notify(`Worktree removed: ${targetPath}`, "info");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Failed to remove worktree: ${msg}`, "error");
          }
          return;
        }

        case "switch": {
          const switchName = parts.slice(1).join("-") || "";
          if (!switchName) {
            ctx.ui.notify("Usage: /worktree switch <name>", "warning");
            return;
          }

          const target = findWorktreeByName(repoRoot, switchName);
          if (!target) {
            ctx.ui.notify(
              `No worktree named "${switchName}". Use /worktree list to see available worktrees.`,
              "error",
            );
            return;
          }

          process.chdir(target.path);
          activeCwd = target.path;
          ctx.ui.notify(`Switched to worktree: ${target.path}`, "info");
          return;
        }

        default:
          ctx.ui.notify(
            `Unknown subcommand "${sub}". Try: list | create <name> | switch <name> | remove <path>`,
            "warning",
          );
      }
    },
  });

  pi.registerFlag("worktree", {
    description:
      "Switch to (or create) a worktree by name at startup. Creates the worktree if it does not exist.",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    const worktreeName = pi.getFlag("worktree") as string | undefined;
    if (!worktreeName) return;

    let repoRoot: string;
    try {
      repoRoot = findGitRoot(process.cwd());
    } catch {
      ctx.ui.notify(
        "Not a git repository. Cannot switch to worktree.",
        "error",
      );
      return;
    }

    // Find existing worktree or create it.
    let targetPath: string;
    const existing = findWorktreeByName(repoRoot, worktreeName);
    if (existing) {
      targetPath = existing.path;
    } else {
      let result: CreateWorktreeResult;
      try {
        result = createWorktree(repoRoot, worktreeName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to create worktree: ${msg}`, "error");
        return;
      }
      targetPath = result.path;
      ctx.ui.notify(
        `Worktree created:\n  Branch: ${result.branch}\n  Path: ${result.path}`,
        "info",
      );
    }

    process.chdir(targetPath);
    activeCwd = targetPath;
    ctx.ui.notify(`Switched to worktree: ${targetPath}`, "info");
  });
}
