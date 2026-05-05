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

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadAgentDefinitions } from "./agent-teams/agent-loader.js";
import { loadTeams } from "./agent-teams/team-loader.js";
import { createRun, runDir, updateRunStatus } from "./agent-teams/run-manager.js";
import { createAgentWorkspace } from "./agent-teams/workspace.js";
import { addTask, addTasks, getTask, listTasks, updateTask } from "./agent-teams/task-board.js";
import { appendHandoff, loadHandoffs } from "./agent-teams/handoff-log.js";
import { spawnAgent, resolveToolsList } from "./agent-teams/agent-runner.js";
import { resolveSkills } from "./agent-teams/skill-loader.js";
import { detectIncompleteRuns, formatIncompleteRunsSummary } from "./agent-teams/crash-recovery.js";
import type {
  AgentDefinition,
  AgentRunResult,
  RunState,
  TeamConfig,
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

/** Track how many agents are currently running (for concurrency control). */
let runningCount = 0;

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

function activateTeam(teamName: string): void {
  activeTeamName = teamName;
  activeTeam = allTeams[teamName] || null;
  teamAgents.clear();

  if (!activeTeam) return;

  const defsByName = new Map(allAgentDefs.map((d) => [d.name.toLowerCase(), d]));
  for (const member of activeTeam.members) {
    const def = defsByName.get(member.toLowerCase());
    if (def) teamAgents.set(def.name.toLowerCase(), def);
  }
}

/**
 * Dispatch an agent: create workspace, log handoff, spawn pi, log completion.
 */
async function dispatchAgentForTask(
  agentName: string,
  taskId: string,
  taskDescription: string,
  ctx: ExtensionContext,
  modelOverride?: string,
): Promise<AgentRunResult> {
  const key = agentName.toLowerCase();
  const agentDef = teamAgents.get(key);
  if (!agentDef) {
    return {
      output: `Agent "${agentName}" not found. Available: ${Array.from(teamAgents.keys()).join(", ")}`,
      exitCode: 1,
      elapsedMs: 0,
    };
  }

  if (!currentRun || !currentRunDir) {
    return {
      output: "No active run. This is a bug — the run should have been created automatically.",
      exitCode: 1,
      elapsedMs: 0,
    };
  }

  // Check concurrency limit.
  if (activeTeam && runningCount >= activeTeam.maxConcurrency) {
    return {
      output: `Concurrency limit reached (${activeTeam.maxConcurrency}). Wait for a running agent to finish.`,
      exitCode: 1,
      elapsedMs: 0,
    };
  }

  // Mark task as in-progress.
  updateTask(currentRunDir, taskId, {
    status: "in-progress",
    assignee: agentName,
  });

  // Create workspace for this agent.
  const workspace = createAgentWorkspace(currentRunDir, agentName);

  // Determine working directory based on workspace mode.
  let agentCwd = projectCwd;
  if (activeTeam?.workspaceMode === "worktree") {
    try {
      const repoRoot = findGitRoot(projectCwd);
      if (!isCleanWorkingTree(repoRoot)) {
        return {
          output: "Cannot create worktree: working tree has uncommitted changes. Commit or stash first.",
          exitCode: 1,
          elapsedMs: 0,
        };
      }
      const wtName = `${currentRun.runId}-${agentName}`;
      const wt = createWorktree(repoRoot, wtName);
      agentCwd = wt.path;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        output: `Failed to create worktree for ${agentName}: ${msg}. Falling back to shared workspace.`,
        exitCode: 1,
        elapsedMs: 0,
      };
    }
  }

  // Log dispatch handoff.
  appendHandoff(currentRunDir, {
    type: "dispatch",
    runId: currentRun.runId,
    fromAgent: "orchestrator",
    toAgent: agentName,
    taskId,
    summary: taskDescription,
  });

  // Build the task prompt including context about the run and workspace.
  const contextPrefix = [
    `# Agent Team Task`,
    `Run ID: ${currentRun.runId}`,
    `Team: ${currentRun.team}`,
    `Task ID: ${taskId}`,
    `Your workspace: ${workspace.root}`,
    `Working directory: ${agentCwd}`,
    "",
    "## Instructions",
    "- Write your working notes to your workspace notes file.",
    "- When done, write a clear summary of what you accomplished.",
    "- Stay focused on the task described below.",
    "",
    "## Task",
  ].join("\n");

  const fullPrompt = `${contextPrefix}\n${taskDescription}`;

  // Resolve model: per-dispatch override > agent frontmatter > parent session model.
  const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const model = modelOverride ?? agentDef.model ?? sessionModel;

  // Resolve skills to inject into the agent's system prompt.
  const { text: skillsText, missing: missingSkills } = resolveSkills(
    projectCwd,
    agentDef.skills ?? [],
  );
  if (missingSkills.length > 0) {
    ctx.ui.notify(
      `Agent "${agentName}": skills not found and will be skipped: ${missingSkills.join(", ")}`,
      "warning",
    );
  }

  // Spawn the agent.
  runningCount++;
  try {
    const result = await spawnAgent({
      agent: agentDef,
      task: fullPrompt,
      workspace,
      cwd: agentCwd,
      model,
      allToolNames: ctx.getActiveTools?.() ?? [],
      skillsText: skillsText || undefined,
    });

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
      artifacts: [`workspaces/${agentName}/output.md`],
      elapsedMs: result.elapsedMs,
    });

    // Update task status.
    updateTask(currentRunDir, taskId, {
      status: result.exitCode === 0 ? "done" : "failed",
      result: truncatedOutput,
    });

    return result;
  } finally {
    runningCount--;
  }
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI): void {
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
      "You can dispatch multiple agents in parallel up to the team's maxConcurrency limit.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name (case-insensitive, e.g. 'researcher')" }),
      taskId: Type.String({ description: "Task ID from the task board to assign to this agent" }),
      task: Type.String({ description: "Detailed task description for the agent" }),
      model: Type.Optional(Type.String({
        description:
          "Model override for this dispatch (e.g. 'anthropic/claude-haiku-4-5'). Defaults to the agent's configured model or the session model.",
      })),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const { agent, taskId, task, model } = params as {
        agent: string;
        taskId: string;
        task: string;
        model?: string;
      };

      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: `Dispatching to ${agent}...` }],
          details: { agent, taskId, status: "dispatching" },
        });
      }

      try {
        const result = await dispatchAgentForTask(agent, taskId, task, ctx, model);
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

  // ── manage_tasks Tool ────────────────────────

  pi.registerTool({
    name: "manage_tasks",
    label: "Manage Tasks",
    description:
      "Manage the shared task board: add, update, list, or get tasks. Use 'add_batch' to create multiple tasks at once with dependency ordering.",
    promptSnippet:
      "manage_tasks — Add, update, list, or get tasks on the shared task board.",
    promptGuidelines: [
      "Always create tasks before dispatching agents to work on them.",
      "Use dependencies to express ordering between tasks.",
      "Update task status as work progresses.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("add_batch"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("get"),
        ],
        { description: "Action to perform" },
      ),
      title: Type.Optional(Type.String({ description: "Task title (for 'add')" })),
      description: Type.Optional(Type.String({ description: "Task description (for 'add')" })),
      dependencies: Type.Optional(
        Type.Array(Type.String(), {
          description: "Task IDs this task depends on (for 'add')",
        }),
      ),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String(),
            description: Type.String(),
            dependencies: Type.Optional(Type.Array(Type.String())),
          }),
          { description: "Batch of tasks to add (for 'add_batch')" },
        ),
      ),
      taskId: Type.Optional(Type.String({ description: "Task ID (for 'update'/'get')" })),
      status: Type.Optional(Type.String({ description: "New status (for 'update')" })),
      result: Type.Optional(Type.String({ description: "Result summary (for 'update')" })),
    }),

    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;

      if (!currentRunDir) {
        return {
          content: [{ type: "text", text: "No active run. Start a conversation first." }],
        };
      }

      switch (p.action) {
        case "add": {
          if (!p.title || !p.description) {
            return {
              content: [
                { type: "text", text: "Missing title or description for 'add' action." },
              ],
            };
          }
          const task = addTask(currentRunDir, {
            title: p.title as string,
            description: p.description as string,
            dependencies: (p.dependencies as string[]) ?? [],
          });
          return {
            content: [
              {
                type: "text",
                text: `Task created: ${task.id} — ${task.title}`,
              },
            ],
            details: task,
          };
        }

        case "add_batch": {
          const items = p.tasks as Array<{
            title: string;
            description: string;
            dependencies?: string[];
          }>;
          if (!items || items.length === 0) {
            return {
              content: [{ type: "text", text: "No tasks provided for 'add_batch'." }],
            };
          }
          const created = addTasks(currentRunDir, items);
          const summary = created
            .map((t) => `  ${t.id}: ${t.title}`)
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text: `Created ${created.length} task(s):\n${summary}`,
              },
            ],
            details: created,
          };
        }

        case "update": {
          if (!p.taskId) {
            return {
              content: [{ type: "text", text: "Missing taskId for 'update' action." }],
            };
          }
          const updated = updateTask(currentRunDir, p.taskId as string, {
            status: p.status as "queued" | "in-progress" | "done" | "failed" | undefined,
            result: p.result as string | undefined,
          });
          if (!updated) {
            return {
              content: [
                { type: "text", text: `Task ${p.taskId} not found.` },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Task ${updated.id} updated: ${updated.status}`,
              },
            ],
            details: updated,
          };
        }

        case "list": {
          const tasks = listTasks(currentRunDir);
          if (tasks.length === 0) {
            return {
              content: [{ type: "text", text: "No tasks on the board yet." }],
            };
          }
          const lines = tasks.map((t) => {
            const status = t.status === "done" ? "✅" : t.status === "failed" ? "❌" : t.status === "in-progress" ? "🔄" : "⏳";
            const assignee = t.assignee ? ` (${t.assignee})` : "";
            const deps = t.dependencies.length > 0 ? ` [deps: ${t.dependencies.join(", ")}]` : "";
            return `${status} ${t.id}: ${t.title}${assignee}${deps}`;
          });
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: tasks,
          };
        }

        case "get": {
          if (!p.taskId) {
            return {
              content: [{ type: "text", text: "Missing taskId for 'get' action." }],
            };
          }
          const task = getTask(currentRunDir, p.taskId as string);
          if (!task) {
            return {
              content: [{ type: "text", text: `Task ${p.taskId} not found.` }],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `${task.id}: ${task.title}\nStatus: ${task.status}\nAssignee: ${task.assignee || "none"}\nDescription: ${task.description}\nResult: ${task.result || "(none)"}`,
              },
            ],
            details: task,
          };
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown action "${p.action}". Use: add, add_batch, update, list, get.`,
              },
            ],
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

      const options = teamNames.map((name) => {
        const t = allTeams[name];
        return `${name} — ${t.description} (${t.members.join(", ")})`;
      });

      const choice = await ctx.ui.select("Select Team", options);
      if (choice === undefined) return;

      const idx = options.indexOf(choice);
      const name = teamNames[idx];
      activateTeam(name);

      if (teamAgents.size > 0) {
        if (!currentRun) {
          currentRun = createRun(ctx.cwd, activeTeamName, "(goal will be set on first dispatch)");
          currentRunDir = runDir(ctx.cwd, activeTeamName, currentRun.runId);
        }
        pi.setActiveTools(["dispatch_agent", "manage_tasks"]);
      } else {
        const allNames = pi.getAllTools().map((t) => t.name);
        pi.setActiveTools(allNames);
      }

      ctx.ui.setStatus(
        "agent-team",
        `Team: ${name} (${teamAgents.size} agents, ${activeTeam?.workspaceMode} mode)`,
      );
      ctx.ui.notify(
        `Team: ${name}\nMembers: ${Array.from(teamAgents.values()).map((a) => displayName(a.name)).join(", ")}\nWorkspace: ${activeTeam?.workspaceMode}\nMax concurrency: ${activeTeam?.maxConcurrency}`,
        "info",
      );
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

      activeTeamName = "";
      activeTeam = null;
      teamAgents.clear();
      currentRun = null;
      currentRunDir = "";

      const allNames = pi.getAllTools()
        .map((t) => t.name)
        .filter((n) => n !== "dispatch_agent" && n !== "manage_tasks");
      pi.setActiveTools(allNames);

      ctx.ui.setStatus("agent-team", undefined);
      ctx.ui.notify("Team mode disabled. Full tool access restored.", "info");
    },
  });

  // ── System Prompt Override ───────────────────

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (teamAgents.size === 0) return undefined;

    const teamMembers = Array.from(teamAgents.values())
      .map((a) => displayName(a.name))
      .join(", ");

    return {
      systemPrompt: `You are an orchestrator agent. You coordinate a team of specialist agents to accomplish tasks.
You do NOT have direct access to the codebase. You MUST delegate all work through
agents using the dispatch_agent tool, and manage work using the manage_tasks tool.

## Active Team: ${activeTeamName}
Members: ${teamMembers}
Workspace mode: ${activeTeam?.workspaceMode ?? "shared"}
Max concurrent agents: ${activeTeam?.maxConcurrency ?? 1}
${currentRun ? `Current run: ${currentRun.runId}` : ""}

## How to Work
1. Analyze the user's request and break it into clear sub-tasks
2. Use manage_tasks (add or add_batch) to create tasks on the shared board with dependencies
3. Dispatch agents to work on tasks using dispatch_agent (provide the task ID)
4. Review results and dispatch follow-up work if needed
5. You can dispatch up to ${activeTeam?.maxConcurrency ?? 1} agents in parallel — use parallel dispatch for independent tasks
6. Summarize the outcome for the user when all tasks are complete

## Rules
- NEVER try to read, write, or execute code directly — you have no such tools
- ALWAYS create a task on the board BEFORE dispatching an agent
- Use dispatch_agent to get work done — provide detailed, focused task descriptions
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused — one clear objective per dispatch
- Check task dependencies before dispatching — don't start a task whose dependencies aren't done

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

    // Create a run for this session.
    currentRun = createRun(ctx.cwd, activeTeamName, "(goal will be set on first dispatch)");
    currentRunDir = runDir(ctx.cwd, activeTeamName, currentRun.runId);

    // Lock down to orchestrator-only tools.
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
        `Max concurrency: ${activeTeam?.maxConcurrency}\n` +
        `Run: ${currentRun.runId}\n\n` +
        `/team-select    Select a team\n` +
        `/team-list      List agents\n` +
        `/team-status    Show run status\n` +
        `/team-handoffs  View handoff log`,
      "info",
    );
  });

  // ── Session Shutdown ───────────────────────

  pi.on("session_shutdown", async () => {
    if (currentRun && currentRun.status === "running") {
      // Check if all tasks are done.
      const tasks = listTasks(currentRunDir);
      const allDone = tasks.length > 0 && tasks.every((t) => t.status === "done" || t.status === "failed");
      const newStatus = allDone ? "completed" : "interrupted";
      updateRunStatus(projectCwd, activeTeamName, currentRun.runId, newStatus);
    }
  });
}
