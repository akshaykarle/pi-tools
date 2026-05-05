// Agent Teams — shared type definitions.

// ── Agent Definition ─────────────────────────────

/** Parsed from `.pi/agents/<name>.md` frontmatter + body. */
export interface AgentDefinition {
  /** Unique agent name (lowercase, kebab-case). */
  name: string;
  /** Human-readable description of the agent's role. */
  description: string;
  /**
   * Allowlist of tool names the agent may use.
   * When set, only these tools are available (passed via `--tools`).
   */
  tools?: string[];
  /**
   * Denylist of tool names the agent must NOT use.
   * Computed to an allowlist at spawn time by subtracting from all available tools.
   * Mutually exclusive with `tools`.
   */
  disallowedTools?: string[];
  /**
   * Default model for this agent (e.g. `anthropic/claude-haiku-4-5`).
   * Overrides the parent session model. Can itself be overridden per-dispatch
   * via the `model` param on `dispatch_agent`.
   */
  model?: string;
  /**
   * Skill names to inject into this agent's system prompt.
   * Skills are discovered from the `pi.skills` directories in `package.json`.
   */
  skills?: string[];
  /** System prompt injected into the child pi session. Taken from the markdown body. */
  systemPrompt: string;
  /** Absolute path to the source `.md` file. */
  filePath: string;
}

// ── Team Configuration ───────────────────────────

export type WorkspaceMode = "shared" | "worktree";

export interface TeamConfig {
  /** Team name (matches key in teams.yaml). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** How agent workspaces are isolated. */
  workspaceMode: WorkspaceMode;
  /** Maximum number of agents that can run in parallel. */
  maxConcurrency: number;
  /** Agent names that belong to this team (must match AgentDefinition.name). */
  members: string[];
}

// ── Task Board ───────────────────────────────────

export type TaskStatus = "queued" | "in-progress" | "done" | "failed";

export interface Task {
  /** Unique task ID (e.g. `task-1`). */
  id: string;
  /** Short title describing the task. */
  title: string;
  /** Detailed description / acceptance criteria. */
  description: string;
  /** Current status. */
  status: TaskStatus;
  /** Agent name assigned to this task (empty when queued). */
  assignee: string;
  /** Task IDs this task depends on (must be `done` before this can start). */
  dependencies: string[];
  /** Result summary written by the agent on completion. */
  result: string;
  /** ISO timestamp when the task was created. */
  createdAt: string;
  /** ISO timestamp of last status change. */
  updatedAt: string;
}

// ── Handoff Log ──────────────────────────────────

export type HandoffType = "dispatch" | "completion" | "failure" | "resume";

export interface HandoffEntry {
  /** ISO timestamp. */
  timestamp: string;
  /** Monotonically increasing sequence number within the run. */
  seq: number;
  /** Kind of handoff event. */
  type: HandoffType;
  /** Run this handoff belongs to. */
  runId: string;
  /** Agent handing off (or "orchestrator"). */
  fromAgent: string;
  /** Agent receiving (or "orchestrator"). */
  toAgent: string;
  /** Related task ID. */
  taskId: string;
  /** Human-readable summary of what happened / what to do next. */
  summary: string;
  /** Relative paths to relevant workspace artifacts. */
  artifacts: string[];
  /** How long the dispatched agent ran (ms). Only set on completion/failure. */
  elapsedMs?: number;
}

// ── Run State ────────────────────────────────────

export type RunStatus = "running" | "completed" | "failed" | "interrupted";

export interface RunState {
  /** Unique run ID (e.g. `run-1750012345678-a1b2`). */
  runId: string;
  /** Team name this run belongs to. */
  team: string;
  /** High-level goal / user request for this run. */
  goal: string;
  /** Current run status. */
  status: RunStatus;
  /** ISO timestamp when the run was created. */
  createdAt: string;
  /** ISO timestamp of last status change. */
  updatedAt: string;
}

// ── Agent Workspace ──────────────────────────────

export interface AgentWorkspacePaths {
  /** Root directory for this agent's workspace. */
  root: string;
  /** Path to the pi session file (for `--session`). */
  sessionFile: string;
  /** Path to the agent's working notes. */
  notesFile: string;
  /** Path to the agent's output file. */
  outputFile: string;
}

// ── Agent Runner ─────────────────────────────────

export interface AgentRunResult {
  /** Full text output from the agent. */
  output: string;
  /** Process exit code. */
  exitCode: number;
  /** Wall-clock time in milliseconds. */
  elapsedMs: number;
}

export type AgentStatus = "idle" | "running" | "done" | "error";
