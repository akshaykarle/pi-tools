// Agent Teams — parse `.pi/agents/teams.yaml` into TeamConfig objects.
//
// We use a minimal hand-rolled YAML parser (same approach as disler/agent-team.ts)
// to avoid adding a YAML dependency. The teams file has a simple structure:
//
//   team-name:
//     description: "..."
//     workspaceMode: shared | worktree
//     maxConcurrency: 2
//     members:
//       - agent-name-1
//       - agent-name-2

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, TeamConfig, WorkspaceMode } from "./types.js";

/** Raw parsed team block before validation. */
interface RawTeam {
  description: string;
  workspaceMode: string;
  maxConcurrency: string;
  members: string[];
}

/**
 * Minimal YAML parser for the teams file.
 * Supports top-level mapping keys, scalar values, and list items.
 */
export function parseTeamsYaml(raw: string): Record<string, RawTeam> {
  const teams: Record<string, RawTeam> = {};
  let current: string | null = null;
  let currentField: string | null = null;

  for (const line of raw.split("\n")) {
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Top-level team key (no leading whitespace)
    const teamMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*$/);
    if (teamMatch) {
      current = teamMatch[1];
      teams[current] = {
        description: "",
        workspaceMode: "shared",
        maxConcurrency: "1",
        members: [],
      };
      currentField = null;
      continue;
    }

    if (!current) continue;

    // Indented scalar field:  key: value
    const scalarMatch = line.match(/^\s+([a-zA-Z_]+)\s*:\s*"?([^"]*?)"?\s*$/);
    if (scalarMatch) {
      const [, key, value] = scalarMatch;
      currentField = key;
      if (key === "description") teams[current].description = value;
      else if (key === "workspaceMode") teams[current].workspaceMode = value;
      else if (key === "maxConcurrency") teams[current].maxConcurrency = value;
      // "members:" with no value just sets the field context for list items
      continue;
    }

    // List item:  - value
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentField === "members") {
      teams[current].members.push(listMatch[1].trim());
    }
  }

  return teams;
}

/**
 * Load and validate teams from `.pi/agents/teams.yaml`.
 *
 * @param cwd  - Project root directory.
 * @param knownAgents - Loaded agent definitions (used to validate member names).
 * @returns Map of team name → TeamConfig. Empty map when the file is missing.
 */
export function loadTeams(
  cwd: string,
  knownAgents: AgentDefinition[],
): Record<string, TeamConfig> {
  const teamsPath = join(cwd, ".pi", "agents", "teams.yaml");

  let raw: string;
  try {
    raw = readFileSync(teamsPath, "utf-8");
  } catch {
    return {};
  }

  const rawTeams = parseTeamsYaml(raw);
  const agentNames = new Set(knownAgents.map((a) => a.name.toLowerCase()));
  const result: Record<string, TeamConfig> = {};

  for (const [name, rt] of Object.entries(rawTeams)) {
    const validMembers = rt.members.filter((m) =>
      agentNames.has(m.toLowerCase()),
    );

    // Skip teams with no valid members.
    if (validMembers.length === 0) continue;

    const wsMode: WorkspaceMode =
      rt.workspaceMode === "worktree" ? "worktree" : "shared";

    const maxConc = parseInt(rt.maxConcurrency, 10);

    result[name] = {
      name,
      description: rt.description,
      workspaceMode: wsMode,
      maxConcurrency: Number.isFinite(maxConc) && maxConc > 0 ? maxConc : 1,
      members: validMembers,
    };
  }

  return result;
}
