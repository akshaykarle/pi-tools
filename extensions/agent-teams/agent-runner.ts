// Agent Teams — spawn child `pi` processes for agent execution.
//
// Each agent runs as a separate `pi` process with `--mode json` for structured
// event streaming. The `--tools` flag whitelists allowed tools. The `--session`
// flag points to the agent's workspace for crash recovery.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentDefinition, AgentRunResult, AgentWorkspacePaths } from "./types.js";

export interface SpawnAgentOptions {
  /** Agent definition. */
  agent: AgentDefinition;
  /** Task prompt to send to the agent. */
  task: string;
  /** Agent workspace paths (session file, etc.). */
  workspace: AgentWorkspacePaths;
  /** Working directory for the child process. */
  cwd: string;
  /** Model string (e.g. "anthropic/claude-sonnet-4-20250514"). */
  model?: string;
  /** All available tool names (used to compute allowlist from disallowedTools). */
  allToolNames?: string[];
  /**
   * Explicit `-e <path>` extension args to pass to the child process.
   * When present, `--no-extensions` is prepended automatically so that only
   * these extensions load (ignoring settings.json discovery).
   * When absent, all project extensions load (minus agent-teams, which is
   * guarded by the `PI_AGENT_TEAMS_CHILD` environment variable).
   */
  extensionArgs?: string[];
  /**
   * Skill directory paths to force-preload via `--skill <dir>`.
   * Used when `extensions` filtering may suppress package-declared skill
   * discovery, or when the agent frontmatter declares specific skills.
   */
  skillDirs?: string[];
  /** Callback for progress updates (last line of agent output). */
  onProgress?: (text: string) => void;
  /** AbortSignal to cancel the agent. */
  signal?: AbortSignal;
}

/**
 * Compute the `--tools` value for an agent.
 *
 * - If `agent.tools` is set, use that directly (allowlist).
 * - If `agent.disallowedTools` is set, subtract from allToolNames.
 * - Otherwise, don't restrict tools (return undefined → omit --tools flag).
 */
export function resolveToolsList(
  agent: AgentDefinition,
  allToolNames: string[],
): string | undefined {
  if (agent.tools && agent.tools.length > 0) {
    return agent.tools.join(",");
  }
  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    const deny = new Set(agent.disallowedTools.map((t) => t.toLowerCase()));
    const allowed = allToolNames.filter((t) => !deny.has(t.toLowerCase()));
    return allowed.length > 0 ? allowed.join(",") : undefined;
  }
  return undefined;
}

/**
 * Build the `pi` CLI args array for a child agent process.
 * Exported for testing — `spawnAgent` calls this internally.
 */
export function buildAgentArgs(opts: Omit<SpawnAgentOptions, "onProgress" | "signal">): string[] {
  const { agent, task, workspace, model, allToolNames, extensionArgs, skillDirs } = opts;

  const args: string[] = [
    "--mode", "json",
    "-p",
    "--thinking", "off",
    "--append-system-prompt", agent.systemPrompt,
    "--session", workspace.sessionFile,
  ];

  // Extension control: if an allowlist is provided, use --no-extensions + explicit -e flags.
  // Otherwise let normal discovery run (PI_AGENT_TEAMS_CHILD guards against recursion).
  if (extensionArgs !== undefined) {
    args.push("--no-extensions");
    args.push(...extensionArgs);
  }

  // Force-preload declared skills via --skill <dir>.
  // This ensures skills are available even when --no-extensions may suppress
  // package-declared skill discovery paths.
  if (skillDirs && skillDirs.length > 0) {
    for (const dir of skillDirs) {
      args.push("--skill", dir);
    }
  }

  // Set model if provided.
  if (model) {
    args.push("--model", model);
  }

  // Compute and set tool whitelist.
  const toolsList = resolveToolsList(agent, allToolNames ?? []);
  if (toolsList) {
    args.push("--tools", toolsList);
  }

  // Resume existing session if one exists.
  if (existsSync(workspace.sessionFile)) {
    args.push("-c");
  }

  // Task prompt goes last.
  args.push(task);

  return args;
}

/**
 * Spawn a child `pi` process for an agent and return a promise that resolves
 * with the agent's output, exit code, and elapsed time.
 */
export function spawnAgent(opts: SpawnAgentOptions): Promise<AgentRunResult> {
  const { cwd, onProgress, signal } = opts;
  const args = buildAgentArgs(opts);

  const startTime = Date.now();
  const textChunks: string[] = [];

  return new Promise<AgentRunResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn("pi", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // PI_AGENT_TEAMS_CHILD prevents agent-teams.ts from registering
        // orchestrator tools in the child process (recursion guard).
        env: { ...process.env, PI_AGENT_TEAMS_CHILD: "1" },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ output: `Error spawning agent: ${msg}`, exitCode: 1, elapsedMs: 0 });
      return;
    }

    let buffer = "";

    // Handle abort signal.
    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may have already exited.
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_update") {
            const delta = event.assistantMessageEvent;
            if (delta?.type === "text_delta") {
              textChunks.push(delta.delta || "");
              if (onProgress) {
                const full = textChunks.join("");
                const lastLine = full.split("\n").filter((l: string) => l.trim()).pop() || "";
                onProgress(lastLine);
              }
            }
          }
        } catch {
          // Non-JSON line — ignore.
        }
      }
    });

    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", () => {
      // Swallow stderr.
    });

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);

      // Process any remaining buffer.
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "message_update") {
            const delta = event.assistantMessageEvent;
            if (delta?.type === "text_delta") {
              textChunks.push(delta.delta || "");
            }
          }
        } catch {
          // Ignore.
        }
      }

      resolve({
        output: textChunks.join(""),
        exitCode: code ?? 1,
        elapsedMs: Date.now() - startTime,
      });
    });

    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({
        output: `Error spawning agent: ${err.message}`,
        exitCode: 1,
        elapsedMs: Date.now() - startTime,
      });
    });
  });
}
