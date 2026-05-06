#!/usr/bin/env npx tsx
// Agent Teams TUI — entry point.
//
// Usage:
//   npx tsx scripts/team-tui.ts [--team <name>] [--run <run-id>]
//
// Runs in a separate terminal alongside an active agent-teams session.
// Polls on-disk run files every 1.5 s and renders a live dashboard.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  findLatestRunId,
  loadAllAgentDefs,
  loadTeamsYaml,
  readNoRunView,
  readRunView,
} from "./team-tui/reader.js";
import { CLEAR_SCREEN, HIDE_CURSOR, SHOW_CURSOR, renderFull } from "./team-tui/render.js";
import type { NoRunView, RunView } from "./team-tui/types.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(): { team?: string; run?: string } {
  const args = process.argv.slice(2);
  const result: { team?: string; run?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--team" || args[i] === "-t") && args[i + 1]) {
      result.team = args[++i];
    } else if ((args[i] === "--run" || args[i] === "-r") && args[i + 1]) {
      result.run = args[++i];
    }
  }
  return result;
}

// ── State ─────────────────────────────────────────────────────────────────────

const cwd = process.cwd();
const cliArgs = parseArgs();

/** All team names from teams.yaml (for cycling). */
let teamNames: string[] = [];
let teamIdx = 0;
let currentTeam: string;
let currentRunId: string | undefined = cliArgs.run;
let scrollOffset = 0;
let lastRefreshMs = 0;
let lastView: RunView | NoRunView | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanup(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  process.stdout.write(SHOW_CURSOR);
  process.stdout.write(CLEAR_SCREEN);
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
  process.stdin.pause();
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

// ── Render ────────────────────────────────────────────────────────────────────

function termWidth(): number {
  return process.stdout.columns ?? 120;
}

function refresh(): void {
  try {
    // Reload team/agent defs each tick (cheap, allows live edits)
    const teams = loadTeamsYaml(cwd);
    teamNames = Array.from(teams.keys());

    if (teamNames.length === 0) {
      process.stdout.write(CLEAR_SCREEN + "  No teams found in .pi/agents/teams.yaml\n  [q] quit\n");
      return;
    }

    // Resolve current team
    if (!currentTeam) {
      currentTeam = cliArgs.team ?? teamNames[0]!;
    }
    if (!teamNames.includes(currentTeam)) {
      currentTeam = teamNames[0]!;
      teamIdx = 0;
    } else {
      teamIdx = teamNames.indexOf(currentTeam);
    }

    const teamConfig = teams.get(currentTeam);
    if (!teamConfig) {
      process.stdout.write(CLEAR_SCREEN + `  Team "${currentTeam}" not found.\n  [q] quit  [t] cycle team\n`);
      return;
    }

    const agentDefs = loadAllAgentDefs(cwd);

    // Resolve run ID: use pinned run, or find latest, or show no-run screen
    let resolvedRunId = currentRunId;
    if (!resolvedRunId) {
      resolvedRunId = findLatestRunId(cwd, currentTeam);
    }

    let view: RunView | NoRunView;
    if (resolvedRunId) {
      const rv = readRunView(cwd, currentTeam, resolvedRunId, teamConfig, agentDefs);
      view = rv ?? readNoRunView(cwd, currentTeam);
    } else {
      view = readNoRunView(cwd, currentTeam);
    }

    lastView = view;
    lastRefreshMs = Date.now();

    const output = renderFull(view, scrollOffset, lastRefreshMs, termWidth());
    process.stdout.write(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(CLEAR_SCREEN + `  Error during refresh: ${msg}\n  [q] quit\n`);
  }
}

// ── Keypress handling ─────────────────────────────────────────────────────────

function handleKey(key: Buffer): void {
  const str = key.toString();

  // q or Ctrl+C
  if (str === "q" || str === "\x03") {
    cleanup();
    process.exit(0);
  }

  // r — force refresh
  if (str === "r") {
    refresh();
    return;
  }

  // t — cycle to next team
  if (str === "t") {
    if (teamNames.length > 1) {
      teamIdx = (teamIdx + 1) % teamNames.length;
      currentTeam = teamNames[teamIdx]!;
      currentRunId = undefined; // reset to latest for new team
      scrollOffset = 0;
      refresh();
    }
    return;
  }

  // ↑ — scroll task board up
  if (str === "\x1b[A") {
    scrollOffset = Math.max(0, scrollOffset - 1);
    if (lastView && "tasks" in lastView) {
      const output = renderFull(lastView, scrollOffset, lastRefreshMs, termWidth());
      process.stdout.write(output);
    }
    return;
  }

  // ↓ — scroll task board down
  if (str === "\x1b[B") {
    if (lastView && "tasks" in lastView) {
      const maxScroll = Math.max(0, lastView.tasks.length - 8);
      scrollOffset = Math.min(maxScroll, scrollOffset + 1);
      const output = renderFull(lastView, scrollOffset, lastRefreshMs, termWidth());
      process.stdout.write(output);
    }
    return;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Verify we're in a pi-tools project
if (!existsSync(join(cwd, ".pi", "agents", "teams.yaml"))) {
  console.error("Error: .pi/agents/teams.yaml not found. Run from project root.");
  process.exit(1);
}

// Hide cursor
process.stdout.write(HIDE_CURSOR);

// Set up raw mode keypress
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleKey);
}

// Initial render + polling loop
refresh();
refreshTimer = setInterval(refresh, 1500);
