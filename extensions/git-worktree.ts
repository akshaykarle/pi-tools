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
  isCleanWorkingTree,
  listWorktrees,
  removeWorktree,
  type CreateWorktreeResult,
} from "./git-worktree/worktree-manager.js";

// Re-export for programmatic use by other extensions.
export {
  createWorktree,
  findGitRoot,
  isCleanWorkingTree,
  linkNodeModules,
  listWorktrees,
  removeWorktree,
} from "./git-worktree/worktree-manager.js";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("worktree", {
    description:
      "Git worktree management: /worktree list | create <name> | remove <path>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || "list";

      let repoRoot: string;
      try {
        repoRoot = findGitRoot(ctx.cwd);
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
            const marker = wt.isMain ? " (main)" : "";
            return `${wt.branch}${marker}\n  ${wt.path}\n  HEAD: ${wt.head?.slice(0, 8) ?? "unknown"}`;
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
            `Worktree created:\n  Branch: ${result.branch}\n  Path: ${result.path}\n  node_modules linked: ${result.nodeModulesLinked}`,
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

        default:
          ctx.ui.notify(
            `Unknown subcommand "${sub}". Try: list | create <name> | remove <path>`,
            "warning",
          );
      }
    },
  });
}
