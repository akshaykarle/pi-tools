// Agent Teams — orchestrator extension for managing teams of AI agents.
//
// The primary pi session becomes a dispatcher that coordinates specialist
// agents. Each agent runs as a separate pi process in a fresh context window
// with its own workspace directory.
//
// Usage: pi -e extensions/agent-teams.ts
//
// Commands:
//   /team-select   — select a team to work with
//   /team-list     — list agents in the active team
//   /team-status   — show run status and task board
//   /team-handoffs — display the handoff audit log

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadAgentDefinitions } from "./agent-teams/agent-loader.js";
import { loadTeams } from "./agent-teams/team-loader.js";
import { createRun, runDir, updateRunStatus } from "./agent-teams/run-manager.js";
import { createAgentWorkspace, getAgentWorkspacePaths } from "./agent-teams/workspace.js";
import { addTask, addTasks, getTask, listTasks, updateTask, setActiveTodosDir, resetActiveTodosDir, type Task, type TaskStatus } from "./todos.js";
import { appendHandoff, loadHandoffs } from "./agent-teams/handoff-log.js";
import { spawnAgent, resolveToolsList } from "./agent-teams/agent-runner.js";
import { findSkillDir, readPiSkillDirs, readPiExtensionPaths } from "./agent-teams/skill-loader.js";
import { detectIncompleteRuns, formatIncompleteRunsSummary } from "./agent-teams/crash-recovery.js";
import { ConcurrencyManager } from "./agent-teams/concurrency-manager.js";
import type {
  AgentDefinition,
  AgentRunResult,
  RunState,
  TeamConfig,
  TeamInstance,
} from "./agent-teams/types.js";

// Re-export the git-worktree helpers so they're available if needed.
import {
  createWorktree,
  findGitRoot,
  isCleanWorkingTree,
  removeWorktree,
} from "./git-worktree/worktree-manager.js";

// ── Module State ─────────────────────────────────

let allAgentDefs: AgentDefinition[] = [];
let allTeams: Record<string, TeamConfig> = {};
let activeTeamName = "";
let activeTeam: TeamConfig | null = null;
let currentRun: RunState | null = null;
let currentRunDir = "";
let projectCwd = "";

/** Map of agent name (lowercase) → definition for the active team. */
const teamAgents = new Map<string, AgentDefinition>();

/** Concurrency gate — tracks active team instances against the team's cap. */
let instanceConcurrency = new ConcurrencyManager(1);

/** Live state of each team instance keyed by instanceId. */
const teamInstances = new Map<number, TeamInstance>();
/** Per-instance running agent count; when it hits 0 the instance slot is released. */
const instanceAgentCount = new Map<number, number>();

// ── Agent Panel State ─────────────────────────────
/** Per-agent live state used to render the team panel widget. */
interface AgentPanelState {
  status: "idle" | "dispatching" | "running" | "done" | "error";
  /** Short model name (provider prefix stripped), e.g. "haiku-4-5". */
  model?: string;
  taskId?: string;
  /** Short task title looked up from tasks.json at dispatch time. */
  taskTitle?: string;
  /** Epoch ms when the most recent dispatch started (for elapsed). */
  startMs?: number;
  /** Most recent totalTokens from session.json (updated every timer tick). */
  totalTokens?: number;
  /** Last non-empty progress line from onProgress callback. */
  lastProgress?: string;
  /** Session file path (set at dispatch time for live token polling). */
  sessionFile?: string;
  /** Team instance this agent belongs to (undefined for cross-team agents). */
  instanceId?: number;
  /** True for cross-team agents not bound to any instance. */
  isCrossTeam?: boolean;
}

const agentPanel = new Map<string, AgentPanelState>();
let panelCtx: ExtensionContext | undefined;
let panelTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ──────────────────────────────────────

function displayName(name: string): string {
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function agentCatalog(): string {
  return Array.from(teamAgents.values())
    .map((a) => {
      const tools = a.tools
        ? `Tools: ${a.tools.join(", ")}`
        : a.disallowedTools
          ? `Disallowed tools: ${a.disallowedTools.join(", ")}`
          : "Tools: all";
      const lines = [
        `### ${displayName(a.name)}`,
        `**Dispatch as:** \`${a.name}\``,
        a.description,
        `**${tools}**`,
      ];
      if (a.model) lines.push(`**Model:** ${a.model}`);
      if (a.skills && a.skills.length > 0) lines.push(`**Skills:** ${a.skills.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

// ── Agent status helpers ──────────────────────────────────────────────────────

/** Format milliseconds as m:ss or h:mm:ss. */
function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Format a token count as "15.9K" / "204K" / "1.2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Read the most recent totalTokens from the last assistant message in an
 * agent's session.json (NDJSON). Returns undefined if the file doesn't exist
 * or contains no assistant messages with usage data.
 */
function readLastTokenCount(sessionFilePath: string): number | undefined {
  try {
    if (!existsSync(sessionFilePath)) return undefined;
    const lines = readFileSync(sessionFilePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]!) as Record<string, unknown>;
        const msg = ev["message"] as Record<string, unknown> | undefined;
        if (ev["type"] === "message" && msg?.["role"] === "assistant") {
          const usage = msg["usage"] as Record<string, unknown> | undefined;
          if (typeof usage?.["totalTokens"] === "number") {
            return usage["totalTokens"] as number;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // File unreadable or other error — silently return undefined.
  }
  return undefined;
}

// ── Agent Panel Widget ────────────────────────────────────────────────────────

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_CYAN = "\x1b[36m";

function ansiLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padTo(s: string, width: number): string {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  const diff = width - plain.length;
  return diff > 0 ? s + " ".repeat(diff) : s;
}

function trunc(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, width - 1) + "\u2026";
}

/** 10-char context bar using block characters. */
function ctxBar(pct: number): string {
  const filled = Math.round(pct / 10);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
  const color = pct >= 85 ? ANSI_RED : pct >= 60 ? ANSI_YELLOW : ANSI_GREEN;
  return `${color}${bar}${ANSI_RESET}`;
}

/** Build the full widget as a string array. */
function buildPanelLines(): string[] {
  const width = process.stdout.columns ?? 100;
  const runStatus = currentRun?.status ?? "none";

  // Status icon and colour for the run
  const runIcon = runStatus === "running" ? `${ANSI_GREEN}\u25cf${ANSI_RESET}`
    : runStatus === "completed" ? `${ANSI_CYAN}\u2713${ANSI_RESET}`
    : runStatus === "failed" ? `${ANSI_RED}\u2717${ANSI_RESET}`
    : `${ANSI_DIM}\u25cb${ANSI_RESET}`;

  const runLabel = currentRun
    ? `${ANSI_BOLD}${activeTeamName}${ANSI_RESET}  ${runIcon}  ${ANSI_DIM}${currentRun.runId.slice(-8)}${ANSI_RESET}`
    : `${ANSI_BOLD}${activeTeamName}${ANSI_RESET}  ${runIcon}  ${ANSI_DIM}idle${ANSI_RESET}`;

  const headerText = ` \u25c6 ${runLabel} `;
  const headerPlainLen = ansiLen(headerText) + 2; // leading " ─── " prefix
  const dashes = "\u2500".repeat(Math.max(0, width - headerPlainLen - 4));
  const header = `${ANSI_DIM} \u2500\u2500\u2500 ${ANSI_RESET}${headerText}${ANSI_DIM}${dashes}${ANSI_RESET}`;

  const footer = `${ANSI_DIM}${"\u2500".repeat(width)}${ANSI_RESET}`;

  // Helper: render a single agent row (shared by flat and grouped modes).
  const buildAgentRow = (name: string, state: AgentPanelState): string => {
    const icon = state.status === "running" ? "\uD83D\uDFE2"
      : state.status === "dispatching" ? "\uD83D\uDFE1"
      : state.status === "done" ? "\u2705"
      : state.status === "error" ? "\u274C"
      : "\u26AA";

    const rowColor = state.status === "running" ? ANSI_GREEN
      : state.status === "done" ? ANSI_CYAN
      : state.status === "error" ? ANSI_RED
      : state.status === "dispatching" ? ANSI_YELLOW
      : ANSI_DIM;

    const modelStr = state.model ? trunc(state.model, 14) : "\u2500";
    const nameStr = padTo(name, 12);
    const modelPadded = padTo(modelStr, 14);

    let taskPart: string;
    if (state.status === "idle") {
      taskPart = padTo(ANSI_DIM + "idle" + ANSI_RESET, 24 + ANSI_DIM.length + ANSI_RESET.length);
    } else if (state.status === "dispatching") {
      taskPart = padTo(ANSI_DIM + "(dispatching\u2026)" + ANSI_RESET, 24 + ANSI_DIM.length + ANSI_RESET.length);
    } else {
      const title = state.taskTitle ?? state.taskId ?? "";
      taskPart = padTo(trunc(title, 24), 24);
    }

    let statsPart = "";
    if (state.status !== "idle" && state.status !== "dispatching" && state.totalTokens !== undefined) {
      const pct = Math.min(100, Math.round((state.totalTokens / 200_000) * 100));
      const bar = ctxBar(pct);
      const pctStr = `${String(pct).padStart(3)}%`;
      const tokStr = padTo(fmtTokens(state.totalTokens), 6);
      statsPart = `  ${bar}  ${pctStr}  ${tokStr}`;
    }

    let elapsedPart = "";
    if (state.startMs !== undefined && (state.status === "running" || state.status === "dispatching")) {
      elapsedPart = `  ${ANSI_DIM}${fmtMs(Date.now() - state.startMs)}${ANSI_RESET}`;
    }

    return `  ${icon}  ${rowColor}${nameStr}${ANSI_RESET}  ${ANSI_DIM}${modelPadded}${ANSI_RESET}  ${taskPart}${statsPart}${elapsedPart}`;
  };

  const useGrouped =
    (activeTeam?.maxConcurrency ?? 1) > 1 ||
    (activeTeam?.crossTeamMembers?.length ?? 0) > 0;

  const rows: string[] = [];

  if (useGrouped) {
    // Separate inner-team entries from cross-team entries.
    const innerTeamEntries: [string, AgentPanelState][] = [];
    const crossTeamEntries: [string, AgentPanelState][] = [];

    for (const entry of agentPanel) {
      if (entry[1].isCrossTeam) {
        crossTeamEntries.push(entry);
      } else {
        innerTeamEntries.push(entry);
      }
    }

    // Group inner-team by instanceId.
    const byInstance = new Map<number | undefined, [string, AgentPanelState][]>();
    for (const entry of innerTeamEntries) {
      const id = entry[1].instanceId;
      const group = byInstance.get(id) ?? [];
      group.push(entry);
      byInstance.set(id, group);
    }

    // Sort: numeric instanceIds first (ascending), undefined at end.
    const sortedKeys = [...byInstance.keys()].sort((a, b) => {
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      return a - b;
    });

    for (const id of sortedKeys) {
      if (id !== undefined) {
        rows.push(`  ${ANSI_DIM}Instance ${id}${ANSI_RESET}`);
      }
      for (const [name, state] of byInstance.get(id)!) {
        rows.push(buildAgentRow(name, state));
      }
    }

    // Cross-team section.
    if (crossTeamEntries.length > 0) {
      rows.push(`  ${ANSI_DIM}\u2500\u2500 Cross-team \u2500\u2500${ANSI_RESET}`);
      for (const [name, state] of crossTeamEntries) {
        rows.push(buildAgentRow(name, state));
      }
    }
  } else {
    // Flat rendering for simple single-instance teams.
    for (const [name, state] of agentPanel) {
      rows.push(buildAgentRow(name, state));
    }
  }

  return [header, ...rows, footer];
}

function updatePanel(ctx: ExtensionContext): void {
  ctx.ui.setWidget("agent-team-panel", buildPanelLines(), { placement: "belowEditor" });
}

function startPanelTimer(ctx: ExtensionContext): void {
  if (panelTimer !== null) return;
  panelTimer = setInterval(() => {
    // Poll session files for running agents to refresh token counts live.
    for (const [, state] of agentPanel) {
      if (state.status === "running" && state.sessionFile) {
        const fresh = readLastTokenCount(state.sessionFile);
        if (fresh !== undefined) state.totalTokens = fresh;
      }
    }
    updatePanel(ctx);
  }, 1000);
}

function stopPanelTimer(): void {
  if (panelTimer !== null) {
    clearInterval(panelTimer);
    panelTimer = null;
  }
}

function activateTeam(teamName: string): void {
  activeTeamName = teamName;
  activeTeam = allTeams[teamName] || null;
  teamAgents.clear();
  teamInstances.clear();
  instanceAgentCount.clear();
  instanceConcurrency = new ConcurrencyManager(activeTeam?.maxConcurrency ?? 1);

  if (!activeTeam) return;

  const defsByName = new Map(allAgentDefs.map((d) => [d.name.toLowerCase(), d]));
  for (const member of activeTeam.members) {
    const def = defsByName.get(member.toLowerCase());
    if (def) teamAgents.set(def.name.toLowerCase(), def);
  }
  // Also register cross-team agent definitions so they can be dispatched.
  for (const member of activeTeam.crossTeamMembers) {
    const def = defsByName.get(member.toLowerCase());
    if (def) teamAgents.set(def.name.toLowerCase(), def);
  }
}

/**
 * Cleans up all per-instance worktrees for the current run. When `ctx` is
 * provided, notifies the user of preserved branches. If `cleanupWorktree` is
 * enabled on the active team, also removes the worktree checkout directories
 * (branches are kept).
 */
function cleanupRunWorktree(ctx?: ExtensionContext): void {
  if (teamInstances.size === 0) return;
  if (!projectCwd) return;

  const preservedBranches: string[] = [];

  for (const inst of teamInstances.values()) {
    if (!inst.branch) continue;
    try {
      if (activeTeam?.cleanupWorktree) {
        const repoRoot = findGitRoot(projectCwd);
        removeWorktree(repoRoot, inst.worktreePath, { deleteBranch: false });
      }
      preservedBranches.push(inst.branch);
    } catch {
      // Best-effort; don't crash on cleanup failure.
    }
  }

  teamInstances.clear();
  instanceAgentCount.clear();
  instanceConcurrency.reset();

  if (ctx && preservedBranches.length > 0) {
    ctx.ui.notify(
      preservedBranches.map((b) => `Worktree branch preserved: ${b}\nReview and merge: git merge ${b}`).join("\n"),
      "info",
    );
  }
}

/**
 * Build a manifest of all known team instances for cross-team agents.
 */
function buildInstanceManifest(): string {
  if (teamInstances.size === 0) return "";
  const lines: string[] = ["\n## Team instances\n"];
  for (const [id, inst] of [...teamInstances.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`Instance ${id}  [status: ${inst.status}]`);
    lines.push(`  Worktree: ${inst.worktreePath}`);
    for (const member of (activeTeam?.members ?? [])) {
      const wp = getAgentWorkspacePaths(currentRunDir, member, id);
      lines.push(`  ${member}: ${wp.outputFile}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Dispatch an agent: create workspace, log handoff, spawn pi, log completion.
 */
async function dispatchAgentForTask(
  agentName: string,
  taskId: string,
  taskDescription: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  modelOverride?: string,
  instanceId?: number,
): Promise<AgentRunResult> {
  const key = agentName.toLowerCase();
  const agentDef = teamAgents.get(key);
  if (!agentDef) {
    const ps0 = agentPanel.get(key) ?? { status: "idle" as const };
    ps0.status = "error";
    agentPanel.set(key, ps0);
    updatePanel(ctx);
    return {
      output: `Agent "${agentName}" not found. Available: ${Array.from(teamAgents.keys()).join(", ")}`,
      exitCode: 1,
      elapsedMs: 0,
    };
  }

  if (!currentRun || !currentRunDir) {
    const ps1 = agentPanel.get(key) ?? { status: "idle" as const };
    ps1.status = "error";
    agentPanel.set(key, ps1);
    updatePanel(ctx);
    return {
      output: "No active run. This is a bug — the run should have been created automatically.",
      exitCode: 1,
      elapsedMs: 0,
    };
  }

  // Determine if this agent is a cross-team agent.
  const isCrossTeam = (activeTeam?.crossTeamMembers ?? []).includes(agentName.toLowerCase());

  // Resolve effective instance ID for inner-team agents.
  let effectiveInstanceId: number | undefined;
  if (!isCrossTeam) {
    effectiveInstanceId = instanceId ?? ((activeTeam?.maxConcurrency ?? 1) === 1 ? 1 : undefined);
    if (effectiveInstanceId === undefined) {
      const psE = agentPanel.get(key) ?? { status: "idle" as const };
      psE.status = "error";
      agentPanel.set(key, psE);
      updatePanel(ctx);
      return {
        output: "teamInstance is required when maxConcurrency > 1",
        exitCode: 1,
        elapsedMs: 0,
      };
    }
  }

  // Mark task as in-progress.
  updateTask(currentRunDir, taskId, {
    status: "in-progress",
    assignee: agentName,
  });

  // Determine working directory and set up instance tracking.
  let agentCwd = projectCwd;
  let dispatchInstanceId: number | undefined;

  if (isCrossTeam) {
    // Cross-team agents always work from the project root.
    agentCwd = projectCwd;
  } else {
    // Inner-team: resolve or create the team instance.
    dispatchInstanceId = effectiveInstanceId!;
    const isNewInstance = !teamInstances.has(dispatchInstanceId);

    if (isNewInstance) {
      // Concurrency gate: only fired when creating a new instance.
      if (!instanceConcurrency.canAcquire()) {
        const psG = agentPanel.get(key) ?? { status: "idle" as const };
        psG.status = "error";
        agentPanel.set(key, psG);
        updatePanel(ctx);
        return {
          output: `Team instance cap (${instanceConcurrency.limit}) reached. Wait for a running instance to complete.`,
          exitCode: 1,
          elapsedMs: 0,
        };
      }

      // Create worktree for this instance if required.
      let instanceWorktreeBranch: string | undefined;
      if (activeTeam?.workspaceMode === "worktree") {
        try {
          const repoRoot = findGitRoot(projectCwd);
          if (!isCleanWorkingTree(repoRoot)) {
            const psW = agentPanel.get(key) ?? { status: "idle" as const };
            psW.status = "error";
            agentPanel.set(key, psW);
            updatePanel(ctx);
            return {
              output: "Cannot create worktree: working tree has uncommitted changes. Commit or stash first.",
              exitCode: 1,
              elapsedMs: 0,
            };
          }
          const wt = createWorktree(repoRoot, `${currentRun.runId}-${dispatchInstanceId}`);
          agentCwd = wt.path;
          instanceWorktreeBranch = wt.branch;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const psWE = agentPanel.get(key) ?? { status: "idle" as const };
          psWE.status = "error";
          agentPanel.set(key, psWE);
          updatePanel(ctx);
          return {
            output: `Failed to create worktree: ${msg}.`,
            exitCode: 1,
            elapsedMs: 0,
          };
        }
      }

      // Register the new instance and acquire a concurrency slot.
      teamInstances.set(dispatchInstanceId, {
        instanceId: dispatchInstanceId,
        worktreePath: agentCwd,
        branch: instanceWorktreeBranch,
        runningAgentCount: 0,
        status: "running",
      });
      instanceConcurrency.acquire();
    } else {
      // Existing instance: reuse the worktree path.
      agentCwd = teamInstances.get(dispatchInstanceId)!.worktreePath;
    }

    // Track per-instance agent count.
    instanceAgentCount.set(dispatchInstanceId, (instanceAgentCount.get(dispatchInstanceId) ?? 0) + 1);
    const inst = teamInstances.get(dispatchInstanceId)!;
    inst.runningAgentCount++;
  }

  // Create workspace for this agent (scoped to instance when inner-team).
  const workspace = createAgentWorkspace(currentRunDir, agentName, dispatchInstanceId);
  const workspacePaths = getAgentWorkspacePaths(currentRunDir, agentName, dispatchInstanceId);

  // Log dispatch handoff.
  appendHandoff(currentRunDir, {
    type: "dispatch",
    runId: currentRun.runId,
    fromAgent: "orchestrator",
    toAgent: agentName,
    taskId,
    summary: taskDescription,
    ...(dispatchInstanceId !== undefined ? { instanceId: dispatchInstanceId } : {}),
  });

  // Build the task prompt including context about the run and workspace.
  const contextLines = [
    `# Agent Team Task`,
    `Run ID: ${currentRun.runId}`,
    `Team: ${currentRun.team}`,
    `Task ID: ${taskId}`,
    `Your workspace: ${workspace.root}`,
    `Working directory: ${agentCwd}`,
  ];

  if (!isCrossTeam && dispatchInstanceId !== undefined) {
    contextLines.push(
      `Team instance: ${dispatchInstanceId} (cap: ${activeTeam?.maxConcurrency ?? 1} concurrent instances)`,
      `Working directory (shared with your team instance): ${agentCwd}`,
    );
  }

  const manifest = isCrossTeam ? buildInstanceManifest() : "";
  if (isCrossTeam && manifest) {
    contextLines.push(manifest);
  }

  contextLines.push(
    "",
    "## Instructions",
    "- Write your working notes to your workspace notes file.",
    "- When done, write a clear summary of what you accomplished.",
    "- Stay focused on the task described below.",
    "",
    "## Task",
  );

  const contextPrefix = contextLines.join("\n");
  const fullPrompt = `${contextPrefix}\n${taskDescription}`;

  // Resolve model: per-dispatch override > agent frontmatter > parent session model.
  const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const model = modelOverride ?? agentDef.model ?? sessionModel;

  // Resolve declared skills to --skill <dir> paths for force-preloading.
  // This ensures skills are available even when --no-extensions may suppress
  // package-declared skill discovery.
  const skillDirsList = readPiSkillDirs(projectCwd);
  const resolvedSkillDirs: string[] = [];
  const missingSkills: string[] = [];
  for (const skillName of agentDef.skills ?? []) {
    const dir = findSkillDir(skillDirsList, skillName);
    if (dir) {
      resolvedSkillDirs.push(dir);
    } else {
      missingSkills.push(skillName);
    }
  }
  if (missingSkills.length > 0) {
    ctx.ui.notify(
      `Agent "${agentName}": skills not found: ${missingSkills.join(", ")}`,
      "warning",
    );
  }

  // Resolve declared extensions to -e <path> args.
  let extensionArgs: string[] | undefined;
  if (agentDef.extensions !== undefined) {
    const extPaths = readPiExtensionPaths(projectCwd);
    const resolvedArgs: string[] = [];
    const missingExts: string[] = [];
    for (const extName of agentDef.extensions) {
      const absPath = extPaths[extName.toLowerCase()];
      if (absPath) {
        resolvedArgs.push("-e", absPath);
      } else {
        missingExts.push(extName);
      }
    }
    if (missingExts.length > 0) {
      ctx.ui.notify(
        `Agent "${agentName}": extensions not found and will be skipped: ${missingExts.join(", ")}`,
        "warning",
      );
    }
    extensionArgs = resolvedArgs;
  }

  // Guard: --plan requires plannotator to be loaded. If extensions are
  // restricted and plannotator is not in the list, fail before spawning.
  if (agentDef.plan === true && agentDef.extensions !== undefined) {
    const hasPlanner = agentDef.extensions.some(
      (e) => e.toLowerCase() === "plannotator" || e.toLowerCase() === "pi-extension"
    );
    if (!hasPlanner) {
      throw new Error(
        `Agent "${agentName}" has plan: true but plannotator is not in its extensions list. ` +
        `Add 'plannotator' to the extensions field or leave extensions unset.`
      );
    }
  }

  // ── Agent panel state: dispatching ───────────────────────────────────────
  const dispatchStartMs = Date.now();
  const taskTitle = getTask(currentRunDir, taskId)?.title;
  {
    const ps = agentPanel.get(key) ?? { status: "idle" as const };
    ps.status = "dispatching";
    ps.model = (model ?? agentDef.model ?? "")?.split("/").pop();
    ps.taskId = taskId;
    ps.taskTitle = taskTitle;
    ps.startMs = dispatchStartMs;
    ps.totalTokens = undefined;
    ps.lastProgress = undefined;
    ps.sessionFile = workspacePaths.sessionFile;
    ps.instanceId = dispatchInstanceId;
    ps.isCrossTeam = isCrossTeam;
    agentPanel.set(key, ps);
  }
  startPanelTimer(ctx);
  updatePanel(ctx);

  try {
    const result = await spawnAgent({
      agent: agentDef,
      task: fullPrompt,
      workspace,
      cwd: agentCwd,
      model,
      allToolNames: pi.getAllTools().map((t) => t.name),
      extensionArgs,
      skillDirs: resolvedSkillDirs.length > 0 ? resolvedSkillDirs : undefined,
      onProgress: (text) => {
        const ps = agentPanel.get(key);
        if (ps) { ps.lastProgress = text; ps.status = "running"; }
      },
    });

    // Update panel state to done/error.
    {
      const ps = agentPanel.get(key);
      if (ps) {
        ps.status = result.exitCode === 0 ? "done" : "error";
        const finalTokens = readLastTokenCount(workspacePaths.sessionFile);
        if (finalTokens !== undefined) ps.totalTokens = finalTokens;
        ps.lastProgress = undefined;
        agentPanel.set(key, ps);
      }
      updatePanel(ctx);
    }

    // Log completion/failure handoff.
    const handoffType = result.exitCode === 0 ? "completion" : "failure";
    const truncatedOutput =
      result.output.length > 2000
        ? result.output.slice(0, 2000) + "\n... [truncated]"
        : result.output;

    appendHandoff(currentRunDir, {
      type: handoffType,
      runId: currentRun.runId,
      fromAgent: agentName,
      toAgent: "orchestrator",
      taskId,
      summary: truncatedOutput || "(no output)",
      artifacts: [workspacePaths.outputFile],
      elapsedMs: result.elapsedMs,
      ...(dispatchInstanceId !== undefined ? { instanceId: dispatchInstanceId } : {}),
    });

    // Update task status.
    updateTask(currentRunDir, taskId, {
      status: result.exitCode === 0 ? "done" : "failed",
      result: truncatedOutput,
    });

    return result;
  } finally {
    if (!isCrossTeam && dispatchInstanceId !== undefined) {
      const newAgentCount = Math.max(0, (instanceAgentCount.get(dispatchInstanceId) ?? 1) - 1);
      instanceAgentCount.set(dispatchInstanceId, newAgentCount);
      const inst2 = teamInstances.get(dispatchInstanceId);
      if (inst2) {
        inst2.runningAgentCount = Math.max(0, inst2.runningAgentCount - 1);
        if (newAgentCount === 0) {
          instanceConcurrency.release();
          inst2.status = "complete";
        }
      }
    }
    if (instanceConcurrency.count === 0) stopPanelTimer();
    updatePanel(ctx);
  }
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Recursion guard: child agent processes set this env var so the agent-teams
  // extension loads (and honours its skills/extensions) without registering
  // orchestrator tools and becoming a recursive dispatcher.
  if (process.env.PI_AGENT_TEAMS_CHILD === "1") return;

  // ── dispatch_agent Tool ──────────────────────

  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description:
      "Dispatch a task to a specialist agent. The agent will execute the task in a fresh context window and return the result. See the system prompt for available agent names.",
    promptSnippet:
      "dispatch_agent — Send a task to a specialist agent on the team.",
    promptGuidelines: [
      "Break work into focused sub-tasks and dispatch to the right specialist.",
      "Always create tasks on the task board before dispatching an agent.",
      "Review agent results before dispatching follow-up work.",
      "maxConcurrency is an upper-bound cap on parallel team instances — you can spin up fewer. Agents within an instance may run in parallel or sequentially at your discretion.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name (case-insensitive, e.g. 'researcher')" }),
      taskId: Type.String({ description: "Task ID from the task board to assign to this agent" }),
      task: Type.String({ description: "Detailed task description for the agent" }),
      model: Type.Optional(Type.String({
        description:
          "Model override for this dispatch (e.g. 'anthropic/claude-haiku-4-5'). Defaults to the agent's configured model or the session model.",
      })),
      teamInstance: Type.Optional(Type.Number({
        description:
          "Team instance number (1-based). Required for inner-team agents when maxConcurrency > 1. " +
          "Omit for cross-team agents (judge etc.) — they receive a manifest of all known instances. " +
          "Defaults to 1 when maxConcurrency is 1 (backwards compatible).",
      })),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const { agent, taskId, task, model, teamInstance } = params as {
        agent: string;
        taskId: string;
        task: string;
        model?: string;
        teamInstance?: number;
      };

      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: `Dispatching to ${agent}...` }],
          details: { agent, taskId, status: "dispatching" },
        });
      }

      try {
        const result = await dispatchAgentForTask(agent, taskId, task, ctx, pi, model, teamInstance);
        const truncated =
          result.output.length > 8000
            ? result.output.slice(0, 8000) + "\n\n... [truncated]"
            : result.output;

        const status = result.exitCode === 0 ? "done" : "error";
        const elapsed = Math.round(result.elapsedMs / 1000);
        const summary = `[${agent}] ${status} in ${elapsed}s`;

        return {
          content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
          details: {
            agent,
            taskId,
            status,
            elapsed: result.elapsedMs,
            exitCode: result.exitCode,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error dispatching to ${agent}: ${msg}` }],
          details: { agent, taskId, status: "error" },
        };
      }
    },
  });

  // ── Commands ─────────────────────────────────

  pi.registerCommand("team-select", {
    description: "Select a team to work with",
    handler: async (_args, ctx) => {
      const teamNames = Object.keys(allTeams);
      if (teamNames.length === 0) {
        ctx.ui.notify(
          "No teams defined. Create .pi/agents/teams.yaml with team definitions.",
          "warning",
        );
        return;
      }

      // Shared helper — emits the “team is now active” status bar entry and
      // notification using current module-level state. Defined here so it
      // can be called both when re-confirming the already-active team and
      // after a genuine switch, keeping both paths in sync automatically.
      const notifyTeamActive = () => {
        ctx.ui.setStatus(
          "agent-team",
          `Team: ${activeTeamName} (${teamAgents.size} agents, ${activeTeam?.workspaceMode} mode)`,
        );
        const members = Array.from(teamAgents.values()).map((a) => displayName(a.name)).join(", ");
        ctx.ui.notify(
          `Team: ${activeTeamName}\nMembers: ${members}\nWorkspace: ${activeTeam?.workspaceMode}\nMax concurrent instances (cap): ${activeTeam?.maxConcurrency}`
            + (currentRun ? `\nRun: ${currentRun.runId}` : ""),
          "info",
        );
      };

      // Show the picker first — we need the chosen name before we can
      // decide whether a warning or any state change is necessary.
      const options = teamNames.map((name) => {
        const t = allTeams[name];
        return `${name} — ${t.description} (${t.members.join(", ")})`;
      });

      const choice = await ctx.ui.select("Select Team", options);
      if (choice === undefined) return;

      const idx = options.indexOf(choice);
      if (idx === -1) return; // safety: should never happen with a well-behaved select
      const name = teamNames[idx]!;

      // Re-selecting the already-active team when a run exists: show current
      // team info as confirmation and bail out — nothing needs to change.
      // When currentRun is null the user may be explicitly initialising
      // the team for the first time (multi-team deferred path), so fall through.
      if (name === activeTeamName && currentRun !== null) {
        notifyTeamActive();
        return;
      }

      // Only warn about interruption when switching to a genuinely different
      // team AND there is an active run that would be lost.
      if (name !== activeTeamName && currentRun !== null && currentRun.status === "running") {
        const confirmed = await ctx.ui.confirm(
          "Switch teams?",
          `You have an active run for "${activeTeamName}" (\u2026${currentRun.runId.slice(-8)}).\nSwitching teams will mark it as interrupted.`,
        );
        if (!confirmed) return;
      }

      // Close out the old run (if any) before switching teams so it is not
      // left permanently as "running" on disk.
      if (currentRun !== null) {
        updateRunStatus(projectCwd, activeTeamName, currentRun.runId, "interrupted");
        cleanupRunWorktree(ctx);
        currentRun = null;
        currentRunDir = "";
      }

      activateTeam(name);

      // Reset agentPanel for the newly selected team so the panel widget
      // reflects the correct members (mirrors panel-init in session_start).
      agentPanel.clear();
      for (const memberName of (activeTeam?.members ?? [])) {
        const def = teamAgents.get(memberName.toLowerCase());
        agentPanel.set(memberName.toLowerCase(), {
          status: "idle",
          model: def?.model?.split("/").pop(),
        });
      }
      // Also seed cross-team members in the panel.
      for (const memberName of (activeTeam?.crossTeamMembers ?? [])) {
        agentPanel.set(memberName.toLowerCase(), {
          status: "idle",
          isCrossTeam: true,
        });
      }
      if (panelCtx) updatePanel(panelCtx);

      if (teamAgents.size > 0) {
        // Always create a fresh run for the newly selected team regardless of
        // whether a run existed before — the old guard `if (!currentRun)` was
        // the root cause of workspaces being written under the wrong team.
        currentRun = createRun(ctx.cwd, activeTeamName, "(goal will be set on first dispatch)");
        currentRunDir = runDir(ctx.cwd, activeTeamName, currentRun.runId);
        if (panelCtx) updatePanel(panelCtx); // refresh panel with live run status

        const hasTodosTool = pi.getAllTools().some((t) => t.name === "manage_tasks");
        if (!hasTodosTool) {
          ctx.ui.notify(
            "Warning: todos extension not loaded. Task management will be unavailable.\nLoad todos.ts alongside agent-teams.ts for full functionality.",
            "warning",
          );
        }
        setActiveTodosDir(currentRunDir);
        pi.setActiveTools(["dispatch_agent", "manage_tasks"]);
      } else {
        const allNames = pi.getAllTools().map((t) => t.name);
        pi.setActiveTools(allNames);
      }

      notifyTeamActive()
    },
  });

  pi.registerCommand("team-list", {
    description: "List agents in the active team",
    handler: async (_args, ctx) => {
      if (teamAgents.size === 0) {
        ctx.ui.notify("No agents loaded. Use /team-select first.", "warning");
        return;
      }
      const lines = Array.from(teamAgents.values()).map((a) => {
        const tools = a.tools
          ? `tools: ${a.tools.join(", ")}`
          : a.disallowedTools
            ? `disallowed: ${a.disallowedTools.join(", ")}`
            : "tools: all";
        return `${displayName(a.name)} — ${a.description} (${tools})`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("team-status", {
    description: "Show current run status and task board",
    handler: async (_args, ctx) => {
      if (!currentRun) {
        ctx.ui.notify("No active run.", "info");
        return;
      }

      const tasks = listTasks(currentRunDir);
      const done = tasks.filter((t) => t.status === "done").length;
      const failed = tasks.filter((t) => t.status === "failed").length;
      const inProgress = tasks.filter((t) => t.status === "in-progress").length;
      const queued = tasks.filter((t) => t.status === "queued").length;

      const lines = [
        `Run: ${currentRun.runId}`,
        `Team: ${currentRun.team}`,
        `Goal: ${currentRun.goal}`,
        `Status: ${currentRun.status}`,
        `Tasks: ${done} done, ${inProgress} in-progress, ${queued} queued, ${failed} failed`,
        "",
      ];

      for (const t of tasks) {
        const icon =
          t.status === "done"
            ? "✅"
            : t.status === "failed"
              ? "❌"
              : t.status === "in-progress"
                ? "🔄"
                : "⏳";
        lines.push(`${icon} ${t.id}: ${t.title} [${t.assignee || "unassigned"}]`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("team-handoffs", {
    description: "Display the handoff audit log",
    handler: async (_args, ctx) => {
      if (!currentRunDir) {
        ctx.ui.notify("No active run.", "info");
        return;
      }

      const handoffs = loadHandoffs(currentRunDir);
      if (handoffs.length === 0) {
        ctx.ui.notify("No handoffs yet.", "info");
        return;
      }

      const lines = handoffs.map((h) => {
        const elapsed = h.elapsedMs ? ` (${Math.round(h.elapsedMs / 1000)}s)` : "";
        const icon =
          h.type === "dispatch"
            ? "📤"
            : h.type === "completion"
              ? "✅"
              : h.type === "failure"
                ? "❌"
                : "🔄";
        const summary =
          h.summary.length > 100
            ? h.summary.slice(0, 97) + "..."
            : h.summary;
        return `${icon} #${h.seq} ${h.fromAgent} → ${h.toAgent} [${h.taskId}]${elapsed}\n   ${summary}`;
      });

      ctx.ui.notify(lines.join("\n\n"), "info");
    },
  });

  pi.registerCommand("team-off", {
    description: "Disable team mode and restore full tool access",
    handler: async (_args, ctx) => {
      if (teamAgents.size === 0 && !activeTeamName) {
        ctx.ui.notify("Team mode is not active.", "info");
        return;
      }

      if (currentRun && currentRun.status === "running") {
        await updateRunStatus(projectCwd, activeTeamName, currentRun.runId, "interrupted");
      }

      cleanupRunWorktree(ctx);
      activeTeamName = "";
      activeTeam = null;
      teamAgents.clear();
      currentRun = null;
      currentRunDir = "";

      const allNames = pi.getAllTools()
        .map((t) => t.name)
        .filter((n) => n !== "dispatch_agent" && n !== "manage_tasks");
      resetActiveTodosDir();
      pi.setActiveTools(allNames);

      ctx.ui.setStatus("agent-team", undefined);
      ctx.ui.notify("Team mode disabled. Full tool access restored.", "info");
    },
  });

  // ── System Prompt Override ───────────────────

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (teamAgents.size === 0) return undefined;

    const innerMembers = Array.from(teamAgents.values())
      .filter((a) => !(activeTeam?.crossTeamMembers ?? []).includes(a.name.toLowerCase()))
      .map((a) => displayName(a.name))
      .join(", ");

    const crossTeamList = (activeTeam?.crossTeamMembers ?? []).join(", ") || "none";

    return {
      systemPrompt: `You are an orchestrator agent. You coordinate a team of specialist agents to accomplish tasks.
You do NOT have direct access to the codebase. You MUST delegate all work through
agents using the dispatch_agent tool, and manage work using the manage_tasks tool.

## Active Team: ${activeTeamName}
Members: ${innerMembers}
Cross-team agents: ${crossTeamList}
Workspace mode: ${activeTeam?.workspaceMode ?? "shared"}
Max concurrent team instances (cap): ${activeTeam?.maxConcurrency ?? 1}
${currentRun ? `Current run: ${currentRun.runId}` : ""}

## How to Work
1. Analyze the user's request and break it into clear sub-tasks
2. Use manage_tasks (add or add_batch) to create tasks on the shared board with dependencies
3. Dispatch agents to work on tasks using dispatch_agent (provide the task ID)
4. Review results and dispatch follow-up work if needed
5. maxConcurrency (${activeTeam?.maxConcurrency ?? 1}) is the cap on parallel team instances — agents within an instance may also run in parallel
6. Summarize the outcome for the user when all tasks are complete

## Rules
- NEVER try to read, write, or execute code directly — you have no such tools
- ALWAYS create a task on the board BEFORE dispatching an agent
- Use dispatch_agent to get work done — provide detailed, focused task descriptions
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused — one clear objective per dispatch
- Check task dependencies before dispatching — don't start a task whose dependencies aren't done
- For inner-team agents: always specify teamInstance (1-based); agents in the same instance share a worktree
- For cross-team agents (${crossTeamList}): omit teamInstance — they receive an instance manifest at dispatch time

## Agents

${agentCatalog()}`,
    };
  });

  // ── Session Start ──────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    projectCwd = ctx.cwd;

    // Load agents and teams.
    allAgentDefs = loadAgentDefinitions(ctx.cwd);
    allTeams = loadTeams(ctx.cwd, allAgentDefs);

    // Check for incomplete runs.
    const incompleteRuns = detectIncompleteRuns(ctx.cwd);
    if (incompleteRuns.length > 0) {
      ctx.ui.notify(
        formatIncompleteRunsSummary(incompleteRuns),
        "warning",
      );
    }

    // Activate first team if available.
    const teamNames = Object.keys(allTeams);
    if (teamNames.length > 0) {
      activateTeam(teamNames[0]);
    }

    if (teamAgents.size === 0) {
      ctx.ui.notify(
        "Agent Teams: No agents found. Create agent definitions in .pi/agents/*.md and teams in .pi/agents/teams.yaml",
        "info",
      );
      return;
    }

    // For single-team setups, create the run immediately so the user can
    // start working without calling /team-select first (preserves existing
    // single-team behaviour).
    // For multi-team setups, defer run creation until the user explicitly
    // picks a team via /team-select — creating one now would stamp all
    // subsequent work under the first (auto-activated) team's directory
    // even if the user selects a different team.
    // run will be created when user selects a team via /team-select
    if (teamNames.length === 1) {
      currentRun = createRun(ctx.cwd, activeTeamName, "(goal will be set on first dispatch)");
      currentRunDir = runDir(ctx.cwd, activeTeamName, currentRun.runId);
    }

    // Initialise agentPanel for all team members and show idle panel.
    panelCtx = ctx;
    agentPanel.clear();
    for (const memberName of (activeTeam?.members ?? [])) {
      const def = teamAgents.get(memberName.toLowerCase());
      agentPanel.set(memberName.toLowerCase(), {
        status: "idle",
        model: def?.model?.split("/").pop(),
      });
    }
    // Also seed cross-team members in the panel.
    for (const memberName of (activeTeam?.crossTeamMembers ?? [])) {
      agentPanel.set(memberName.toLowerCase(), {
        status: "idle",
        isCrossTeam: true,
      });
    }
    updatePanel(ctx);

    // Lock down to orchestrator-only tools and redirect todos to run dir.
    // Only redirect todos when a run directory already exists (single-team
    // path); in the multi-team path the redirect happens inside /team-select.
    if (currentRunDir) {
      setActiveTodosDir(currentRunDir);
    }
    pi.setActiveTools(["dispatch_agent", "manage_tasks"]);

    const members = Array.from(teamAgents.values())
      .map((a) => displayName(a.name))
      .join(", ");

    ctx.ui.setStatus(
      "agent-team",
      `Team: ${activeTeamName} (${teamAgents.size} agents)`,
    );
    ctx.ui.notify(
      `Agent Teams loaded!\n` +
        `Team: ${activeTeamName} (${members})\n` +
        `Workspace: ${activeTeam?.workspaceMode}\n` +
        `Max concurrent instances (cap): ${activeTeam?.maxConcurrency}\n` +
        (currentRun
          ? `Run: ${currentRun.runId}\n\n`
          : `Use /team-select to begin working with a team\n\n`) +
        `/team-select    Select a team\n` +
        `/team-list      List agents\n` +
        `/team-status    Show run status\n` +
        `/team-handoffs  View handoff log`,
      "info",
    );
  });

  // ── Session Shutdown ───────────────────────

  pi.on("session_shutdown", async (_event, ctx) => {
    if (currentRun && currentRun.status === "running") {
      // Check if all tasks are done.
      const tasks = listTasks(currentRunDir);
      const allDone = tasks.length > 0 && tasks.every((t) => t.status === "done" || t.status === "failed");
      const newStatus = allDone ? "completed" : "interrupted";
      updateRunStatus(projectCwd, activeTeamName, currentRun.runId, newStatus);
      cleanupRunWorktree(ctx);
    }

    // Stop the panel timer and remove the panel widget on shutdown.
    stopPanelTimer();
    ctx.ui.setWidget("agent-team-panel", undefined);
  });
}
