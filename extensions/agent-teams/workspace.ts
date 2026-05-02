// Agent Teams — per-agent workspace directory management.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentWorkspacePaths } from "./types.js";

/**
 * Create the workspace directory for an agent within a run and return paths.
 *
 * Layout:
 *   <runDir>/workspaces/<agentName>/
 *     session.json   — Pi session file (for --session and crash recovery)
 *     notes.md       — Agent's working notes
 *     output.md      — Agent's output for the completed task
 */
export function createAgentWorkspace(
  runDirPath: string,
  agentName: string,
): AgentWorkspacePaths {
  const root = join(runDirPath, "workspaces", agentName);
  mkdirSync(root, { recursive: true });

  return {
    root,
    sessionFile: join(root, "session.json"),
    notesFile: join(root, "notes.md"),
    outputFile: join(root, "output.md"),
  };
}

/**
 * Return workspace paths without creating directories (for read-only checks).
 */
export function getAgentWorkspacePaths(
  runDirPath: string,
  agentName: string,
): AgentWorkspacePaths {
  const root = join(runDirPath, "workspaces", agentName);
  return {
    root,
    sessionFile: join(root, "session.json"),
    notesFile: join(root, "notes.md"),
    outputFile: join(root, "output.md"),
  };
}
