// Backlog dashboard extension — live TUI widget for submission rankings.
//
// DISPLAY-ONLY: this extension reads *.eval.json and *.attempts.jsonl but
// never writes to them.
//
// Usage: loaded automatically when listed in pi.extensions in package.json.
// Keyboard shortcuts can be overridden via <agentDir>/extensions/backlog-dashboard.json.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadDashboardConfig } from "./config.js";
import { readDashboardState, watchBacklogDir } from "./reader.js";
import { renderWidgetLine, renderExpandedView } from "./widget.js";
import { getBacklogDir } from "../todos.js";

const STATUS_KEY = "backlog";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const context = ctx as ExtensionContext & { cwd: string };
    const agentDir = getAgentDir();
    const config = loadDashboardConfig(agentDir);

    if (config.disabled) return;

    const backlogDir = getBacklogDir(context.cwd);

    // ── Initial render ──────────────────────────────────────────────────────
    const state = readDashboardState(backlogDir);
    context.ui.setStatus(STATUS_KEY, renderWidgetLine(state));

    // ── File watcher ────────────────────────────────────────────────────────
    let currentState = state;
    const stopWatcher = watchBacklogDir(backlogDir, () => {
      currentState = readDashboardState(backlogDir);
      context.ui.setStatus(STATUS_KEY, renderWidgetLine(currentState));
    });

    // ── Keyboard shortcut — expanded view ───────────────────────────────────
    if (config.expandKey) {
      pi.registerCommand("backlog", {
        description: "Show backlog submission rankings. Usage: /backlog [task-id]",
        async handler(args, ctx2) {
          const c2 = ctx2 as ExtensionContext;
          const taskId = args.trim() || undefined;
          const fresh = readDashboardState(backlogDir);
          c2.ui.notify(renderExpandedView(fresh, taskId), "info");
        },
      });
    }

    // ── Session shutdown ────────────────────────────────────────────────────
    pi.on("session_shutdown", async () => {
      stopWatcher();
      context.ui.setStatus(STATUS_KEY, undefined);
    });
  });
}
