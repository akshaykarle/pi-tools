// Backlog dashboard — inline TUI widget and expanded view renderers.
//
// DISPLAY-ONLY: these functions render state to strings; they do not write files.

import type { DashboardState, TaskSummary } from "./reader.js";

// ── Confidence indicator ──────────────────────────────────────────────────────

/**
 * Return a colour-coded confidence emoji.
 *   🟢  score >= min_ratio           (above threshold)
 *   🟡  score >= min_ratio * 0.8    (within 20% below threshold)
 *   🔴  score < min_ratio * 0.8     (well below threshold)
 */
export function confidenceIndicator(task: TaskSummary): string {
  const { confidenceScore, minRatio } = task;
  if (confidenceScore >= minRatio) return "🟢";
  if (confidenceScore >= minRatio * 0.8) return "🟡";
  return "🔴";
}

// ── Inline widget ─────────────────────────────────────────────────────────────

/**
 * Render a single-line summary for ctx.ui.setStatus.
 * Empty state → "📋 No active tasks"
 * One task per entry, space-separated when multiple tasks are active.
 */
export function renderWidgetLine(state: DashboardState): string {
  if (state.length === 0) {
    return "📋 No active tasks";
  }

  const parts = state.map((task) => {
    const titleShort = task.title.length > 20
      ? task.title.slice(0, 18) + "…"
      : task.title;

    const attempts =
      task.maxAttempts !== null
        ? `${task.attemptCount}/${task.maxAttempts}`
        : `${task.attemptCount}`;

    const score = task.championScore !== null
      ? `score:${task.championScore.toFixed(1)}`
      : "no submissions";

    const cost =
      task.maxCostUsd !== null
        ? `$${task.costUsdUsed.toFixed(2)}/$${task.maxCostUsd}`
        : `$${task.costUsdUsed.toFixed(2)}`;

    const indicator = confidenceIndicator(task);

    return `[${task.taskId}:${titleShort} ${attempts} ${score} ${indicator} ${cost}]`;
  });

  return `📋 ${parts.join(" ")}`;
}

// ── Expanded view ─────────────────────────────────────────────────────────────

/**
 * Render the full rankings table for one or all tasks.
 * Pass taskId to filter to a single task; omit for all tasks.
 */
export function renderExpandedView(state: DashboardState, taskId?: string): string {
  const tasks = taskId
    ? state.filter((t) => t.taskId === taskId)
    : state;

  if (tasks.length === 0) {
    return taskId
      ? `No data for task ${taskId}. Run 'manage_tasks evaluate' to generate results.`
      : "No active tasks in backlog. Run 'manage_tasks import_backlog' to import specs.";
  }

  const sections: string[] = [];

  for (const task of tasks) {
    const lines: string[] = [];
    lines.push(`━━ Task ${task.taskId}: ${task.title} ${"━".repeat(Math.max(0, 50 - task.title.length))}`);
    lines.push(
      `   Attempts: ${task.attemptCount}${task.maxAttempts !== null ? `/${task.maxAttempts}` : ""}` +
      `   Cost: $${task.costUsdUsed.toFixed(2)}${task.maxCostUsd !== null ? `/$${task.maxCostUsd}` : ""}` +
      `   Confidence: ${task.confidenceScore.toFixed(2)} ${confidenceIndicator(task)} (min: ${task.minRatio})`,
    );

    if (task.ranking.length === 0) {
      lines.push("   No submissions yet.");
    } else {
      lines.push("");
      lines.push("   Rank  Agent                  Score   Status");
      lines.push("   ─────────────────────────────────────────────");
      for (const entry of task.ranking) {
        const agent = entry.agent.padEnd(22).slice(0, 22);
        const score = entry.score.toFixed(2).padStart(6);
        const status = entry.status;
        const champion = status === "champion" ? " ★" : "";
        lines.push(`   ${String(entry.rank).padStart(4)}  ${agent} ${score}   ${status}${champion}`);
      }
    }

    if (task.recommendation) {
      lines.push("");
      lines.push(`   → ${task.recommendation}`);
    }

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}
