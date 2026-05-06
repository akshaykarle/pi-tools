// Agent Teams TUI — ANSI renderer.
//
// Pure rendering functions. No filesystem access. Receives typed view objects
// from reader.ts and writes ANSI-escaped strings to stdout.

import type { AgentView, HandoffView, RunView, NoRunView, TaskView } from "./types.js";
import { AGENT_STATUS_ICON } from "./types.js";

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const BRIGHT_WHITE = "\x1b[97m";
const BG_DARK = "\x1b[48;5;235m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

export { HIDE_CURSOR, SHOW_CURSOR, CLEAR_SCREEN };

function color(c: string, text: string): string { return `${c}${text}${RESET}`; }
function bold(text: string): string { return `${BOLD}${text}${RESET}`; }
function dim(text: string): string { return `${DIM}${text}${RESET}`; }

/** Pad string to width, truncating with "…" if too long. Safe for plain ASCII. */
function pad(str: string, width: number, align: "left" | "right" = "left"): string {
  // Strip ANSI for length calculation
  const plain = str.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length > width) {
    const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
    return stripped.slice(0, width - 1) + "…";
  }
  const pad = " ".repeat(width - plain.length);
  return align === "right" ? pad + str : str + pad;
}

/** Repeat a string n times. */
function repeat(ch: string, n: number): string { return ch.repeat(Math.max(0, n)); }

// ── Context bar ───────────────────────────────────────────────────────────────

/** Render a 10-character context bar with color coding. */
function contextBar(pct: number | undefined): string {
  if (pct === undefined) return dim("──────────");
  const filled = Math.round((pct / 100) * 10);
  const bar = repeat("█", filled) + repeat("░", 10 - filled);
  const c = pct >= 85 ? RED : pct >= 60 ? YELLOW : GREEN;
  return color(c, bar);
}

/** Format token count as "15.9K" or "204K" etc. */
function fmtTokens(n: number | undefined): string {
  if (n === undefined) return dim("—");
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format elapsed ms as "0:01:23". */
function fmtElapsed(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return dim("—");
  const s = Math.floor(ms / 1000);
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  const hrs = Math.floor(mins / 60);
  const m = String(mins % 60).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  if (hrs > 0) return `${hrs}:${m}:${ss}`;
  return `${mins}:${ss}`;
}

/** Format a run status string with color. */
function fmtRunStatus(status: string): string {
  switch (status) {
    case "running": return color(GREEN, "● RUNNING");
    case "completed": return color(CYAN, "✓ DONE");
    case "failed": return color(RED, "✗ FAILED");
    case "interrupted": return color(YELLOW, "⚡ INTERRUPTED");
    case "none": return color(DIM, "○ IDLE");
    default: return dim(status.toUpperCase());
  }
}

// ── Header ────────────────────────────────────────────────────────────────────

export function renderHeader(view: RunView | NoRunView, termWidth: number): string {
  const isRun = "runId" in view;
  const team = color(CYAN, bold(view.team));

  if (!isRun) {
    const line1 = ` 🤖 ${bold("AGENT TEAMS")}  │  ${team}  │  no active run  │  ${fmtRunStatus("none")} `;
    const inner = termWidth - 4;
    const plain1 = line1.replace(/\x1b\[[0-9;]*m/g, "");
    const pad1 = repeat(" ", Math.max(0, inner - plain1.length));
    return [
      "╔" + repeat("═", termWidth - 2) + "╗",
      "║  " + line1 + pad1 + "  ║",
      "╚" + repeat("═", termWidth - 2) + "╝",
    ].join("\n");
  }

  const runId = dim(view.runId);
  const status = fmtRunStatus(view.status);
  const line1 = ` 🤖 ${bold("AGENT TEAMS")}  │  ${team}  │  ${runId}  │  ${status} `;
  const goalRaw = view.goal.length > termWidth - 6 ? view.goal.slice(0, termWidth - 7) + "…" : view.goal;
  const line2 = ` Goal: ${dim(goalRaw)} `;

  const inner = termWidth - 4;
  const plain1 = line1.replace(/\x1b\[[0-9;]*m/g, "");
  const plain2 = line2.replace(/\x1b\[[0-9;]*m/g, "");

  return [
    "╔" + repeat("═", termWidth - 2) + "╗",
    "║  " + line1 + repeat(" ", Math.max(0, inner - plain1.length)) + "  ║",
    "║  " + line2 + repeat(" ", Math.max(0, inner - plain2.length)) + "  ║",
    "╚" + repeat("═", termWidth - 2) + "╝",
  ].join("\n");
}

// ── Agent cards ───────────────────────────────────────────────────────────────

/** Number of columns given terminal width (1–3). */
function numCols(termWidth: number): number {
  if (termWidth >= 100) return 3;
  if (termWidth >= 66) return 2;
  return 1;
}

/** Card inner width given number of columns. */
function cardInnerWidth(termWidth: number, cols: number): number {
  // Account for col separators (2 chars each between cols) + outer border (2)
  const gaps = (cols - 1) * 2;
  return Math.floor((termWidth - 2 - gaps) / cols) - 2;
}

function renderAgentCard(agent: AgentView, innerW: number): string[] {
  const icon = AGENT_STATUS_ICON[agent.status];
  const nameStr = `${icon} ${agent.name.toUpperCase()}`;
  const nameColor = agent.status === "running" ? GREEN
    : agent.status === "done" ? CYAN
    : agent.status === "error" ? RED
    : WHITE;

  const model = agent.model ? dim(agent.model) : dim("—");
  const taskId = agent.currentTaskId ? dim(agent.currentTaskId) : dim("Idle");
  const taskTitle = agent.currentTaskTitle
    ? (agent.currentTaskTitle.length > innerW
        ? agent.currentTaskTitle.slice(0, innerW - 1) + "…"
        : agent.currentTaskTitle)
    : "";

  const ctxPctStr = agent.contextPct !== undefined ? ` ${String(agent.contextPct).padStart(3)}%` : "  — ";
  const ctxBar = contextBar(agent.contextPct);
  const tokStr = agent.totalTokens !== undefined
    ? `${fmtTokens(agent.totalTokens)} tokens`
    : dim("— tokens");

  const tools = agent.recentTools.length > 0
    ? agent.recentTools.slice(0, 4).join(" ")
    : (agent.allowedTools ? agent.allowedTools.slice(0, 4).join(" ") : dim("(all)"));
  const toolsLabel = agent.recentTools.length > 0 ? "Recent: " : "Tools:  ";

  const elapsed = agent.status === "running" && agent.elapsedMs !== undefined
    ? `Elapsed: ${fmtElapsed(agent.elapsedMs)}`
    : agent.status === "done"
    ? `Done: ${agent.tasksDone} task${agent.tasksDone !== 1 ? "s" : ""}`
    : agent.status === "error"
    ? color(RED, "Error / failed")
    : dim("Idle");

  const w = innerW;

  function line(content: string): string {
    const plain = content.replace(/\x1b\[[0-9;]*m/g, "");
    const padding = repeat(" ", Math.max(0, w - plain.length));
    return "│ " + content + padding + " │";
  }

  return [
    "┌" + repeat("─", w + 2) + "┐",
    line(color(nameColor, bold(nameStr))),
    line(model),
    line(taskId),
    line(taskTitle ? taskTitle : repeat(" ", 0)),
    line(`Ctx: ${ctxBar}${ctxPctStr}`),
    line(tokStr),
    line(`${toolsLabel}${tools}`),
    line(elapsed),
    "└" + repeat("─", w + 2) + "┘",
  ];
}

export function renderAgentCards(agents: AgentView[], termWidth: number): string {
  const cols = numCols(termWidth);
  const innerW = cardInnerWidth(termWidth, cols);
  const rows: string[][] = [];

  for (let i = 0; i < agents.length; i += cols) {
    const rowAgents = agents.slice(i, i + cols);
    const cardLines = rowAgents.map((a) => renderAgentCard(a, innerW));

    // Pad all cards to same number of lines
    const maxLines = Math.max(...cardLines.map((c) => c.length));
    const paddedCards = cardLines.map((c) => {
      while (c.length < maxLines) c.push("│" + repeat(" ", innerW + 2) + "│");
      return c;
    });

    const combined: string[] = [];
    for (let ln = 0; ln < maxLines; ln++) {
      combined.push(paddedCards.map((c) => c[ln]!).join("  "));
    }
    rows.push(combined);
  }

  return rows.map((r) => r.join("\n")).join("\n");
}

// ── Task board ────────────────────────────────────────────────────────────────

const TASK_STATUS_ICON: Record<string, string> = {
  queued: "⏳",
  "in-progress": "🔄",
  done: "✅",
  failed: "❌",
};

export function renderTaskBoard(
  tasks: TaskView[],
  termWidth: number,
  scrollOffset: number,
): string {
  const visibleRows = Math.min(tasks.length, 8);
  const headerLine = "┌─── TASK BOARD " + repeat("─", termWidth - 17) + "┐";
  const footerLine = "└" + repeat("─", termWidth - 2) + "┘";

  if (tasks.length === 0) {
    return [headerLine, "│  " + dim("No tasks yet.") + repeat(" ", termWidth - 17) + "  │", footerLine].join("\n");
  }

  const idW = 14;
  const statusW = 12;
  const assigneeW = 12;
  const elapsedW = 10;
  const titleW = Math.max(10, termWidth - idW - statusW - assigneeW - elapsedW - 10);

  const header = "│  " +
    bold(pad("ID", idW)) + "  " +
    bold(pad("TITLE", titleW)) + "  " +
    bold(pad("ASSIGNEE", assigneeW)) + "  " +
    bold(pad("STATUS", statusW)) + "  " +
    bold(pad("ELAPSED", elapsedW, "right")) +
    "  │";

  const divider = "│" + repeat("─", termWidth - 2) + "│";

  const visible = tasks.slice(scrollOffset, scrollOffset + visibleRows);
  const taskLines = visible.map((t) => {
    const icon = TASK_STATUS_ICON[t.status] ?? "?";
    const statusStr = icon + " " + t.status;
    const statusColor = t.status === "done" ? GREEN
      : t.status === "failed" ? RED
      : t.status === "in-progress" ? YELLOW
      : DIM;

    const elapsedStr = t.elapsedMs !== undefined ? fmtElapsed(t.elapsedMs) : "—";
    const assigneeStr = t.assignee || dim("—");

    return "│  " +
      dim(pad(t.id, idW)) + "  " +
      pad(t.title, titleW) + "  " +
      pad(assigneeStr, assigneeW) + "  " +
      pad(color(statusColor, statusStr), statusW + 4) + "  " +
      pad(dim(elapsedStr), elapsedW, "right") +
      "  │";
  });

  const scrollHint = tasks.length > visibleRows
    ? dim(`  ${scrollOffset + 1}–${Math.min(scrollOffset + visibleRows, tasks.length)} of ${tasks.length}  ↑↓`)
    : "";

  return [headerLine, header, divider, ...taskLines, footerLine + scrollHint].join("\n");
}

// ── Handoff log ───────────────────────────────────────────────────────────────

const HANDOFF_ICON: Record<string, string> = {
  dispatch: "📤",
  completion: "✅",
  failure: "❌",
  resume: "🔁",
};

export function renderHandoffLog(handoffs: HandoffView[], termWidth: number): string {
  const headerLine = "┌─── HANDOFF LOG " + repeat("─", termWidth - 18) + "┐";
  const footerLine = "└" + repeat("─", termWidth - 2) + "┘";

  if (handoffs.length === 0) {
    return [headerLine, "│  " + dim("No handoffs yet.") + repeat(" ", termWidth - 20) + "  │", footerLine].join("\n");
  }

  const recent = handoffs.slice(-6).reverse();
  const lines = recent.map((h) => {
    const icon = HANDOFF_ICON[h.type] ?? "?";
    const ts = h.timestamp.slice(11, 19); // HH:MM:SS
    const elapsed = h.elapsedMs ? `  ${dim(fmtElapsed(h.elapsedMs))}` : "";
    const typeLabel = pad(h.type, 10);
    const typeColor = h.type === "completion" ? GREEN : h.type === "failure" ? RED : BLUE;
    const from = pad(h.fromAgent, 12);
    const to = pad(h.toAgent, 12);
    const task = dim(`[${h.taskId}]`);

    const content = `  #${String(h.seq).padStart(2, "0")}  ${dim(ts)}  ${icon} ${color(typeColor, typeLabel)}  ${from} → ${to}  ${task}${elapsed}`;
    const plain = content.replace(/\x1b\[[0-9;]*m/g, "");
    const padding = repeat(" ", Math.max(0, termWidth - plain.length - 4));

    return "│" + content + padding + "│";
  });

  return [headerLine, ...lines, footerLine].join("\n");
}

// ── Footer ────────────────────────────────────────────────────────────────────

export function renderFooter(team: string, lastRefreshMs: number, termWidth: number): string {
  const ago = Math.round((Date.now() - lastRefreshMs) / 1000);
  const refreshStr = ago === 0 ? "just now" : `${ago}s ago`;
  const keys = `${bold("[q]")} quit  ${bold("[r]")} refresh  ${bold("[t]")} cycle team  ${bold("[↑↓]")} scroll tasks`;
  const right = dim(`team: ${team}  │  refreshed: ${refreshStr}  ●`);

  const plainKeys = keys.replace(/\x1b\[[0-9;]*m/g, "");
  const plainRight = right.replace(/\x1b\[[0-9;]*m/g, "");
  const gap = Math.max(2, termWidth - plainKeys.length - plainRight.length - 2);

  return "\n  " + keys + repeat(" ", gap) + right;
}

// ── No-run screen ─────────────────────────────────────────────────────────────

export function renderNoRunScreen(view: NoRunView, termWidth: number): string {
  const lines: string[] = [];
  lines.push(renderHeader(view, termWidth));
  lines.push("");
  lines.push("  " + color(YELLOW, "Watching .pi/agent-teams/runs/" + view.team + "/ for a new run…"));
  lines.push("");
  if (view.lastRunId) {
    const ts = view.lastRunUpdatedAt ? "  (" + view.lastRunUpdatedAt.slice(0, 19).replace("T", " ") + ")" : "";
    lines.push("  " + dim("Last completed run: " + view.lastRunId + ts));
    lines.push("");
  }
  lines.push("  " + dim("[q] quit  [t] cycle team  [r] refresh"));
  return lines.join("\n");
}

// ── Full render ───────────────────────────────────────────────────────────────

export function renderFull(
  view: RunView | NoRunView,
  scrollOffset: number,
  lastRefreshMs: number,
  termWidth: number,
): string {
  if (!("runId" in view)) {
    return CLEAR_SCREEN + renderNoRunScreen(view, termWidth) + "\n";
  }

  const parts: string[] = [
    CLEAR_SCREEN,
    renderHeader(view, termWidth),
    "",
    renderAgentCards(view.agents, termWidth),
    "",
    renderTaskBoard(view.tasks, termWidth, scrollOffset),
    "",
    renderHandoffLog(view.handoffs, termWidth),
    renderFooter(view.team, lastRefreshMs, termWidth),
    "",
  ];
  return parts.join("\n");
}
