// Agent Teams TUI — filesystem reader.
//
// Reads all on-disk files produced by agent-teams.ts and derives a fully-typed
// RunView that the renderer can consume without any filesystem knowledge.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, HandoffEntry, RunState, Task, TeamConfig } from "../../extensions/agent-teams/types.js";
import { loadHandoffs } from "../../extensions/agent-teams/handoff-log.js";
import { loadRun, runDir, teamRunsDir } from "../../extensions/agent-teams/run-manager.js";
import { getAgentWorkspacePaths } from "../../extensions/agent-teams/workspace.js";
import type { AgentStatus, AgentView, HandoffView, NoRunView, RunView, TaskView } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum context tokens per model family. Default 200 K for all Claude models. */
const MODEL_MAX_TOKENS: Record<string, number> = {
  default: 200_000,
};

function modelMaxTokens(modelId?: string): number {
  if (!modelId) return MODEL_MAX_TOKENS.default;
  for (const [key, max] of Object.entries(MODEL_MAX_TOKENS)) {
    if (key !== "default" && modelId.includes(key)) return max;
  }
  return MODEL_MAX_TOKENS.default;
}

// ── YAML + Markdown loaders (inline, no extra deps) ───────────────────────────

/** Very small YAML front-matter + body parser (handles the subset used in .pi/agents/*.md). */
function parseAgentMd(content: string): Partial<AgentDefinition> {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { systemPrompt: content };
  const fm = fmMatch[1]!;
  const body = fmMatch[2]!.trim();

  const result: Record<string, unknown> = { systemPrompt: body };
  for (const line of fm.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m as [string, string, string];
    if (key === "tools" || key === "disallowedTools" || key === "skills" || key === "extensions") {
      result[key] = val ? val.split(",").map((s) => s.trim()).filter(Boolean) : [];
    } else if (key === "plan") {
      result[key] = val.trim() === "true";
    } else {
      result[key] = val.trim();
    }
  }
  return result as Partial<AgentDefinition>;
}

/** Load all agent definitions from `.pi/agents/` (skip teams.yaml). */
export function loadAllAgentDefs(cwd: string): Map<string, Partial<AgentDefinition>> {
  const agentsDir = join(cwd, ".pi", "agents");
  const defs = new Map<string, Partial<AgentDefinition>>();
  if (!existsSync(agentsDir)) return defs;

  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = readFileSync(join(agentsDir, file), "utf-8");
      const def = parseAgentMd(content);
      const name = def.name ?? file.replace(/\.md$/, "");
      defs.set(name, { ...def, name, filePath: join(agentsDir, file) });
    } catch {
      // Skip unreadable files.
    }
  }
  return defs;
}

/** Very small YAML parser for teams.yaml (handles the specific structure used). */
export function loadTeamsYaml(cwd: string): Map<string, TeamConfig> {
  const filePath = join(cwd, ".pi", "agents", "teams.yaml");
  const teams = new Map<string, TeamConfig>();
  if (!existsSync(filePath)) return teams;

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  let currentTeam: string | null = null;
  let currentConfig: Partial<TeamConfig> & { members?: string[] } = {};
  let inMembers = false;

  const flush = () => {
    if (currentTeam && currentConfig.description !== undefined) {
      teams.set(currentTeam, {
        name: currentTeam,
        description: currentConfig.description ?? "",
        workspaceMode: (currentConfig.workspaceMode as "shared" | "worktree") ?? "shared",
        maxConcurrency: currentConfig.maxConcurrency ?? 2,
        members: currentConfig.members ?? [],
      });
    }
  };

  for (const line of lines) {
    // Top-level team key (no indent, ends with colon)
    const teamMatch = line.match(/^([a-zA-Z][a-zA-Z0-9-_]*):\s*$/);
    if (teamMatch && !line.startsWith(" ")) {
      flush();
      currentTeam = teamMatch[1]!;
      currentConfig = {};
      inMembers = false;
      continue;
    }
    if (!currentTeam) continue;

    // members list item
    if (inMembers && line.match(/^\s+-\s+(.+)$/)) {
      const member = line.match(/^\s+-\s+(.+)$/)![1]!.trim();
      (currentConfig.members ??= []).push(member);
      continue;
    }

    // Key-value pairs inside a team
    const kvMatch = line.match(/^\s{2}(\w+):\s*(.*)$/);
    if (!kvMatch) { inMembers = false; continue; }
    const [, key, val] = kvMatch as [string, string, string];

    if (key === "members") {
      currentConfig.members = [];
      inMembers = true;
    } else if (key === "maxConcurrency") {
      currentConfig.maxConcurrency = parseInt(val, 10);
      inMembers = false;
    } else if (key === "workspaceMode") {
      currentConfig.workspaceMode = val.trim() as "shared" | "worktree";
      inMembers = false;
    } else if (key === "description") {
      currentConfig.description = val.trim().replace(/^"|"$/g, "");
      inMembers = false;
    }
  }
  flush();
  return teams;
}

// ── Session.json reader ────────────────────────────────────────────────────────

interface SessionStats {
  model?: string;
  totalTokens?: number;
  recentTools: string[];
}

/** Parse agent session.json (NDJSON) and extract model, last token usage, recent tools. */
function readSessionStats(sessionFilePath: string): SessionStats {
  if (!existsSync(sessionFilePath)) return { recentTools: [] };

  let content: string;
  try {
    content = readFileSync(sessionFilePath, "utf-8");
  } catch {
    return { recentTools: [] };
  }

  let model: string | undefined;
  let totalTokens: number | undefined;
  const recentToolCallNames: string[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;

      // Model change event
      if (event["type"] === "model_change" && !model) {
        model = event["modelId"] as string | undefined;
      }

      // Assistant message — grab token usage and tool calls
      if (event["type"] === "message") {
        const msg = event["message"] as Record<string, unknown> | undefined;
        if (!msg) continue;

        if (msg["role"] === "assistant") {
          // Token usage
          const usage = msg["usage"] as Record<string, unknown> | undefined;
          if (usage && typeof usage["totalTokens"] === "number") {
            totalTokens = usage["totalTokens"] as number;
          }
          // Also check model on assistant message
          if (!model && typeof msg["model"] === "string") {
            model = msg["model"] as string;
          }

          // Tool calls
          const content = msg["content"] as unknown[] | undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (b["type"] === "toolCall" && typeof b["name"] === "string") {
                recentToolCallNames.push(b["name"] as string);
              }
            }
          }
        }
      }
    } catch {
      // Skip malformed lines.
    }
  }

  // Return last 6 unique tool names (preserving insertion order)
  const seen = new Set<string>();
  const recentTools: string[] = [];
  for (const name of recentToolCallNames.slice(-20).reverse()) {
    if (!seen.has(name)) {
      seen.add(name);
      recentTools.unshift(name);
    }
    if (recentTools.length >= 6) break;
  }

  return { model, totalTokens, recentTools };
}

// ── Run discovery ─────────────────────────────────────────────────────────────

/** Find the latest run ID for a team (by directory mtime). Returns undefined if none. */
export function findLatestRunId(cwd: string, teamName: string): string | undefined {
  const dir = teamRunsDir(cwd, teamName);
  if (!existsSync(dir)) return undefined;

  const entries = readdirSync(dir)
    .filter((name) => name.startsWith("run-"))
    .map((name) => ({
      name,
      mtime: statSync(join(dir, name)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return entries[0]?.name;
}

// ── Main reader ────────────────────────────────────────────────────────────────

/** Build a full RunView from on-disk files. Returns null if the run doesn't exist. */
export function readRunView(
  cwd: string,
  teamName: string,
  runId: string,
  teamConfig: TeamConfig,
  agentDefs: Map<string, Partial<AgentDefinition>>,
): RunView | null {
  const runState: RunState | null = loadRun(cwd, teamName, runId);
  if (!runState) return null;

  const rDir = runDir(cwd, teamName, runId);

  // ── Tasks ──────────────────────────────────────────────────────────────────
  const rawTasks: Task[] = (() => {
    const p = join(rDir, "tasks.json");
    if (!existsSync(p)) return [];
    try { return JSON.parse(readFileSync(p, "utf-8")) as Task[]; } catch { return []; }
  })();

  // ── Handoffs ───────────────────────────────────────────────────────────────
  const rawHandoffs: HandoffEntry[] = loadHandoffs(rDir);
  rawHandoffs.sort((a, b) => a.seq - b.seq);

  // Build agent status from handoffs: last event per agent determines status
  const agentLastHandoff = new Map<string, HandoffEntry>();
  for (const h of rawHandoffs) {
    if (h.type === "dispatch") agentLastHandoff.set(h.toAgent, h);
    else if (h.type === "completion" || h.type === "failure") agentLastHandoff.set(h.fromAgent, h);
  }

  // Build dispatch timestamps for computing elapsed time for running agents
  const agentDispatchTs = new Map<string, number>();
  for (const h of rawHandoffs) {
    if (h.type === "dispatch") {
      agentDispatchTs.set(h.toAgent, new Date(h.timestamp).getTime());
    } else if (h.type === "completion" || h.type === "failure") {
      agentDispatchTs.delete(h.fromAgent);
    }
  }

  // ── Per-agent views ────────────────────────────────────────────────────────
  const agents: AgentView[] = teamConfig.members.map((agentName) => {
    const def = agentDefs.get(agentName) ?? {};
    const lastHandoff = agentLastHandoff.get(agentName);

    let status: AgentStatus = "idle";
    if (lastHandoff) {
      if (lastHandoff.type === "dispatch" && lastHandoff.toAgent === agentName) status = "running";
      else if (lastHandoff.type === "completion" && lastHandoff.fromAgent === agentName) status = "done";
      else if (lastHandoff.type === "failure" && lastHandoff.fromAgent === agentName) status = "error";
    }

    // Session stats
    const wsPaths = getAgentWorkspacePaths(rDir, agentName);
    const session = readSessionStats(wsPaths.sessionFile);

    // Context %
    const maxTok = modelMaxTokens(session.model ?? (def.model?.split("/").pop()));
    const contextPct = session.totalTokens !== undefined
      ? Math.min(100, Math.round((session.totalTokens / maxTok) * 100))
      : undefined;

    // Current task (in-progress for this agent)
    const currentTask = rawTasks.find(
      (t) => t.assignee === agentName && t.status === "in-progress",
    );

    // Elapsed
    const dispatchTs = agentDispatchTs.get(agentName);
    const elapsedMs = dispatchTs !== undefined ? Date.now() - dispatchTs : undefined;

    // Tasks done
    const tasksDone = rawTasks.filter(
      (t) => t.assignee === agentName && t.status === "done",
    ).length;

    return {
      name: agentName,
      description: (def.description as string | undefined) ?? "",
      status,
      model: session.model ?? (def.model?.split("/").pop()),
      currentTaskId: currentTask?.id,
      currentTaskTitle: currentTask?.title,
      totalTokens: session.totalTokens,
      contextPct,
      recentTools: session.recentTools,
      allowedTools: def.tools as string[] | undefined,
      elapsedMs,
      tasksDone,
    };
  });

  // ── Task views ─────────────────────────────────────────────────────────────
  // Build elapsed for done/failed from handoff log
  const taskCompletionMs = new Map<string, number>();
  const taskDispatchTs = new Map<string, number>();
  for (const h of rawHandoffs) {
    if (h.type === "dispatch") taskDispatchTs.set(h.taskId, new Date(h.timestamp).getTime());
    if ((h.type === "completion" || h.type === "failure") && h.elapsedMs !== undefined) {
      taskCompletionMs.set(h.taskId, h.elapsedMs);
    }
  }

  const tasks: TaskView[] = rawTasks.map((t) => {
    let elapsedMs: number | undefined;
    if (t.status === "done" || t.status === "failed") {
      elapsedMs = taskCompletionMs.get(t.id);
    } else if (t.status === "in-progress") {
      const ds = taskDispatchTs.get(t.id);
      if (ds !== undefined) elapsedMs = Date.now() - ds;
    }
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      assignee: t.assignee,
      elapsedMs,
      dependencies: t.dependencies,
    };
  });

  // ── Handoff views ──────────────────────────────────────────────────────────
  const handoffs: HandoffView[] = rawHandoffs.map((h) => ({
    seq: h.seq,
    timestamp: h.timestamp,
    type: h.type as HandoffView["type"],
    fromAgent: h.fromAgent,
    toAgent: h.toAgent,
    taskId: h.taskId,
    elapsedMs: h.elapsedMs,
  }));

  return {
    runId,
    team: runState.team,
    goal: runState.goal,
    status: runState.status,
    createdAt: runState.createdAt,
    updatedAt: runState.updatedAt,
    agents,
    tasks,
    handoffs,
  };
}

/** Build a NoRunView when there is no active run. */
export function readNoRunView(cwd: string, teamName: string): NoRunView {
  const latestId = findLatestRunId(cwd, teamName);
  if (!latestId) return { team: teamName };

  const state = loadRun(cwd, teamName, latestId);
  return {
    team: teamName,
    lastRunId: latestId,
    lastRunUpdatedAt: state?.updatedAt,
  };
}
