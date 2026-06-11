// Agent Teams — per-agent workspace directory management.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentWorkspacePaths } from "./types.js";

/**
 * Create the workspace directory for an agent within a run and return paths.
 *
 * Layout:
 *   - With `instanceId`:  <runDir>/workspaces/<agentName>-<instanceId>/
 *   - Without `instanceId`: <runDir>/workspaces/<agentName>/  (backwards compat)
 *
 *     session.json   — Pi session file (for --session and crash recovery)
 *     notes.md       — Agent's working notes
 *     output.md      — Agent's output for the completed task
 *
 * @param instanceId  Optional team instance number (1-based). When provided, the
 *                    workspace directory is scoped to `<agentName>-<instanceId>`
 *                    to prevent collisions when the same agent runs in multiple
 *                    parallel instances.
 */
export function createAgentWorkspace(
  runDirPath: string,
  agentName: string,
  instanceId?: number,
): AgentWorkspacePaths {
  const dirName = instanceId !== undefined ? `${agentName}-${instanceId}` : agentName;
  const root = join(runDirPath, "workspaces", dirName);
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
 *
 * - With `instanceId`:  root is `<runDir>/workspaces/<agentName>-<instanceId>/`
 * - Without `instanceId`: root is `<runDir>/workspaces/<agentName>/` (backwards compat)
 *
 * @param instanceId  Optional team instance number (1-based). When provided, the
 *                    path is scoped to `<agentName>-<instanceId>` to match the
 *                    directory created by `createAgentWorkspace`.
 */
export function getAgentWorkspacePaths(
  runDirPath: string,
  agentName: string,
  instanceId?: number,
): AgentWorkspacePaths {
  const dirName = instanceId !== undefined ? `${agentName}-${instanceId}` : agentName;
  const root = join(runDirPath, "workspaces", dirName);
  return {
    root,
    sessionFile: join(root, "session.json"),
    notesFile: join(root, "notes.md"),
    outputFile: join(root, "output.md"),
  };
}
