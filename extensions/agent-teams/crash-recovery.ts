// Agent Teams — crash recovery: detect interrupted runs and offer to resume.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState, Task } from "./types.js";
import { runsRoot } from "./run-manager.js";

export interface IncompleteRun {
  /** The run state. */
  run: RunState;
  /** Tasks that were in-progress when the run was interrupted. */
  interruptedTasks: Task[];
  /** Tasks that were completed before interruption. */
  completedTasks: Task[];
  /** Tasks that were still queued. */
  queuedTasks: Task[];
}

/**
 * Scan all team run directories for runs with status "running" that
 * have tasks stuck in "in-progress". These are likely interrupted runs.
 */
export function detectIncompleteRuns(cwd: string): IncompleteRun[] {
  const root = runsRoot(cwd);
  if (!existsSync(root)) return [];

  const results: IncompleteRun[] = [];

  // Iterate over team directories
  let teamDirs: string[];
  try {
    teamDirs = readdirSync(root);
  } catch {
    return [];
  }

  for (const teamDir of teamDirs) {
    const teamPath = join(root, teamDir);

    let runDirs: string[];
    try {
      runDirs = readdirSync(teamPath);
    } catch {
      continue;
    }

    for (const runDirName of runDirs) {
      const runJsonPath = join(teamPath, runDirName, "run.json");
      const tasksJsonPath = join(teamPath, runDirName, "tasks.json");

      // Load run state
      let run: RunState;
      try {
        run = JSON.parse(readFileSync(runJsonPath, "utf-8")) as RunState;
      } catch {
        continue;
      }

      // Only look at runs that are still "running".
      if (run.status !== "running") continue;

      // Load tasks
      let tasks: Task[];
      try {
        tasks = JSON.parse(readFileSync(tasksJsonPath, "utf-8")) as Task[];
      } catch {
        // No tasks file — still an incomplete run.
        tasks = [];
      }

      const interruptedTasks = tasks.filter((t) => t.status === "in-progress");
      const completedTasks = tasks.filter((t) => t.status === "done");
      const queuedTasks = tasks.filter((t) => t.status === "queued");

      // A run is considered "incomplete" if it has in-progress tasks
      // (the process that was running them is no longer alive)
      // OR if it's still "running" with queued tasks remaining.
      if (interruptedTasks.length > 0 || queuedTasks.length > 0) {
        results.push({
          run,
          interruptedTasks,
          completedTasks,
          queuedTasks,
        });
      }
    }
  }

  return results;
}

/**
 * Format incomplete runs into a human-readable summary for display.
 */
export function formatIncompleteRunsSummary(runs: IncompleteRun[]): string {
  if (runs.length === 0) return "No incomplete runs found.";

  const lines: string[] = [`Found ${runs.length} incomplete run(s):`, ""];

  for (const { run, interruptedTasks, completedTasks, queuedTasks } of runs) {
    lines.push(`📋 ${run.runId} (team: ${run.team})`);
    lines.push(`   Goal: ${run.goal}`);
    lines.push(`   Created: ${run.createdAt}`);
    lines.push(
      `   Tasks: ${completedTasks.length} done, ${interruptedTasks.length} interrupted, ${queuedTasks.length} queued`,
    );

    if (interruptedTasks.length > 0) {
      lines.push(`   Interrupted:`);
      for (const t of interruptedTasks) {
        lines.push(`     - ${t.id}: ${t.title} (assigned: ${t.assignee || "none"})`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
