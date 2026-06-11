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
   * Skill names to force-preload via `--skill <dir>` when spawning the child process.
   *
   * **Only set this when the agent also has a restricted `extensions:` field.**
   * In the default case (`extensions` absent), all project skills auto-discover
   * natively in the child process — no declaration needed.
   *
   * When `extensions:` restricts loading (`--no-extensions` mode), package-declared
   * `pi.skills` paths may be suppressed. Listing skills here passes explicit
   * `--skill <dir>` args to ensure they are always available.
   */
  skills?: string[];
  /**
   * Controls which extensions load in the child agent process.
   *
   * - `undefined` (absent in frontmatter): all project extensions load. The
   *   `PI_AGENT_TEAMS_CHILD` env var prevents agent-teams from recursing.
   * - `[]` (empty — `extensions: ""` in frontmatter): `--no-extensions` is passed;
   *   no extension `.ts` files load. Project-local `.pi/skills/` still auto-discovers.
   * - `["security", "sandbox"]`: `--no-extensions -e <security-path> -e <sandbox-path>`.
   *   Only the listed extensions load.
   */
  extensions?: string[];
  /**
   * When `true`, passes `--plan` to the child process, starting the session in
   * plannotator's planning phase. Plannotator must be available (either via
   * unrestricted extensions or explicitly listed in the `extensions` field).
   */
  plan?: boolean;
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
  /**
   * Upper-bound cap on how many team instances may be active simultaneously.
   * The orchestrator may spin up fewer — the cap only prevents exceeding it.
   * Previously controlled per-agent concurrency; now controls per-instance concurrency.
   */
  maxConcurrency: number;
  /** Agent names that belong to this team (must match AgentDefinition.name). */
  members: string[];
  /** Agents not bound to any team instance; dispatched at the orchestrator's discretion. */
  crossTeamMembers: string[];
  /** Remove the worktree directory (not the branch) when the run ends. Default: false.
   * In teams.yaml use `cleanupWorktree: true` (only the literal string "true" is accepted). */
  cleanupWorktree?: boolean;
}

/** Live state for one parallel team instance. */
export interface TeamInstance {
  /** Numeric label (1-based). */
  instanceId: number;
  /** Absolute path to this instance's worktree (or projectCwd for shared mode). */
  worktreePath: string;
  /** Branch name (worktree mode only). */
  branch?: string;
  /** Number of agents currently running in this instance (may be >1 for parallel work). */
  runningAgentCount: number;
  /** Lifecycle status of this instance. */
  status: "running" | "complete" | "failed";
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
  /** Team instance this handoff belongs to (inner-team dispatches only; absent for cross-team). */
  instanceId?: number;
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
