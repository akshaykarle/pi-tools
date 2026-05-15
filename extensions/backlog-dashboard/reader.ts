// Backlog dashboard — file reader and directory watcher.
//
// DISPLAY-ONLY: this module reads *.eval.json and *.attempts.jsonl but never
// writes to them.

import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { EvalJson } from "../todos/eval-engine.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TaskSummary {
  taskId: string;
  title: string;
  attemptCount: number;
  maxAttempts: number | null;
  costUsdUsed: number;
  maxCostUsd: number | null;
  championScore: number | null;
  confidenceScore: number;
  confidenceAboveThreshold: boolean;
  minRatio: number;
  recommendation: string;
  ranking: EvalJson["ranking"];
}

export type DashboardState = TaskSummary[];

// ── Reader ────────────────────────────────────────────────────────────────────

/**
 * Read the current dashboard state from all *.eval.json files in the backlog dir.
 * Returns an empty array if the directory doesn't exist or has no eval files.
 * Never throws.
 */
export function readDashboardState(backlogDir: string): DashboardState {
  if (!existsSync(backlogDir)) return [];

  let files: string[];
  try {
    files = readdirSync(backlogDir).filter((f) => f.endsWith(".eval.json"));
  } catch {
    return [];
  }

  const state: DashboardState = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(backlogDir, file), "utf-8")) as EvalJson;
      const champion = raw.ranking?.[0] ?? null;
      state.push({
        taskId: raw.task_id,
        title: file.replace(/^\d+-/, "").replace(/\.eval\.json$/, "").replace(/-/g, " "),
        attemptCount: raw.attempt_count,
        maxAttempts: raw.budget?.max_attempts ?? null,
        costUsdUsed: raw.budget?.cost_usd_used ?? 0,
        maxCostUsd: raw.budget?.max_cost_usd ?? null,
        championScore: champion?.score ?? null,
        confidenceScore: raw.confidence?.score ?? 0,
        confidenceAboveThreshold: raw.confidence?.aboveThreshold ?? false,
        minRatio: raw.confidence?.minRatio ?? 2.0,
        recommendation: raw.recommendation ?? "",
        ranking: raw.ranking ?? [],
      });
    } catch {
      // Malformed eval.json — skip silently.
    }
  }

  return state.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

// ── Watcher ───────────────────────────────────────────────────────────────────

/**
 * Watch the backlog directory for changes to *.eval.json and *.attempts.jsonl.
 * Calls onUpdate (debounced at 500ms) whenever a relevant file changes.
 *
 * Falls back to polling (1s interval) if fs.watch is unavailable or throws.
 * Returns a stop function that clears the watcher.
 */
export function watchBacklogDir(dir: string, onUpdate: () => void): () => void {
  // Debounce: delay calls to onUpdate by 500ms to avoid UI thrash.
  let debounceTimer: NodeJS.Timeout | null = null;
  const debouncedUpdate = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onUpdate, 500);
  };

  let watcher: FSWatcher | null = null;
  let pollInterval: NodeJS.Timeout | null = null;

  try {
    // Attempt fs.watch on the directory.
    // On macOS and Linux this fires for all file changes within the dir.
    if (!existsSync(dir)) {
      // Directory doesn't exist yet — fall back to polling so we pick it up
      // if it's created mid-session.
      throw new Error("Directory does not exist yet");
    }
    watcher = watch(dir, { persistent: false }, (event, filename) => {
      if (
        filename &&
        (filename.endsWith(".eval.json") || filename.endsWith(".attempts.jsonl"))
      ) {
        debouncedUpdate();
      }
    });
    watcher.on("error", () => {
      // fs.watch error mid-session — fall back to polling.
      watcher?.close();
      watcher = null;
      startPolling();
    });
  } catch {
    // fs.watch not available or dir doesn't exist — use polling.
    startPolling();
  }

  function startPolling() {
    pollInterval = setInterval(debouncedUpdate, 1000);
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher?.close();
    if (pollInterval) clearInterval(pollInterval);
  };
}
