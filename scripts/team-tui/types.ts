// Agent Teams TUI — derived view types.
//
// These types are what the renderer consumes. They are derived from the raw
// disk types (RunState, Task, HandoffEntry, AgentDefinition) by reader.ts.
// Keeping them separate means render.ts has no filesystem knowledge.

/** Status of an individual agent within the current run. */
export type AgentStatus = "idle" | "running" | "done" | "error";

/** Status icon character for each agent status. */
export const AGENT_STATUS_ICON: Record<AgentStatus, string> = {
  idle: "⚪",
  running: "🟢",
  done: "✅",
  error: "❌",
};

/** Derived per-agent view for the TUI. */
export interface AgentView {
  /** Agent name (e.g. "researcher"). */
  name: string;
  /** Human-readable description from agent .md frontmatter. */
  description: string;
  /** Runtime status derived from handoff log. */
  status: AgentStatus;
  /** Model string (e.g. "claude-haiku-4-5") or undefined if not yet started. */
  model?: string;
  /** Current task ID if running/done, undefined if idle. */
  currentTaskId?: string;
  /** Current task title (truncated by renderer). */
  currentTaskTitle?: string;
  /** Most recent totalTokens from last assistant message in session.json. */
  totalTokens?: number;
  /** Context window percentage (0–100), derived from totalTokens / model max. */
  contextPct?: number;
  /** Tool names from the last 3 unique tool calls in session.json. */
  recentTools: string[];
  /** Allowed tools from agent definition (undefined = all tools). */
  allowedTools?: string[];
  /** Wall-clock ms since the most recent dispatch (only meaningful when running). */
  elapsedMs?: number;
  /** Number of tasks completed by this agent (status === "done") in this run. */
  tasksDone: number;
}

/** Derived task view for the TUI. */
export interface TaskView {
  id: string;
  title: string;
  status: "queued" | "in-progress" | "done" | "failed";
  assignee: string;
  /** Wall-clock elapsed ms (set for done/failed from handoff log, live for in-progress). */
  elapsedMs?: number;
  dependencies: string[];
}

/** Derived handoff view for the TUI. */
export interface HandoffView {
  seq: number;
  timestamp: string;
  type: "dispatch" | "completion" | "failure" | "resume";
  fromAgent: string;
  toAgent: string;
  taskId: string;
  elapsedMs?: number;
}

/** Full derived run view for the TUI — everything the renderer needs. */
export interface RunView {
  /** Run ID string. */
  runId: string;
  /** Team name. */
  team: string;
  /** Goal / description for this run. */
  goal: string;
  /** Overall run status. */
  status: "running" | "completed" | "failed" | "interrupted" | "none";
  /** ISO start timestamp. */
  createdAt: string;
  /** ISO last-updated timestamp. */
  updatedAt: string;
  /** All agents on the team (including idle ones). */
  agents: AgentView[];
  /** Task board. */
  tasks: TaskView[];
  /** Full handoff log, sorted by seq ascending. */
  handoffs: HandoffView[];
}

/** Minimal context returned when there is no active or recent run. */
export interface NoRunView {
  team: string;
  lastRunId?: string;
  lastRunUpdatedAt?: string;
}
