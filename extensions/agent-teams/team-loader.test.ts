import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTeams, parseTeamsYaml } from "./team-loader.js";
import type { AgentDefinition } from "./types.js";

let tmpDir: string;

const fakeAgent = (name: string): AgentDefinition => ({
  name,
  description: `Agent ${name}`,
  systemPrompt: "prompt",
  filePath: `/fake/${name}.md`,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "team-loader-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseTeamsYaml", () => {
  it("parses a valid teams YAML", () => {
    const yaml = `
dev-team:
  description: "Development team"
  workspaceMode: worktree
  maxConcurrency: 3
  members:
    - researcher
    - implementer

research-only:
  description: "Research team"
  workspaceMode: shared
  maxConcurrency: 1
  members:
    - researcher
`;
    const result = parseTeamsYaml(yaml);
    expect(Object.keys(result)).toEqual(["dev-team", "research-only"]);
    expect(result["dev-team"].description).toBe("Development team");
    expect(result["dev-team"].workspaceMode).toBe("worktree");
    expect(result["dev-team"].maxConcurrency).toBe("3");
    expect(result["dev-team"].members).toEqual(["researcher", "implementer"]);
    expect(result["research-only"].members).toEqual(["researcher"]);
  });

  it("handles comments and blank lines", () => {
    const yaml = `
# This is a comment
team-a:
  description: "Team A"

  workspaceMode: shared
  # Another comment
  maxConcurrency: 2
  members:
    - agent-1
`;
    const result = parseTeamsYaml(yaml);
    expect(result["team-a"].members).toEqual(["agent-1"]);
  });

  it("returns empty for empty input", () => {
    expect(parseTeamsYaml("")).toEqual({});
  });
});

describe("loadTeams", () => {
  it("loads and validates teams", () => {
    const agentsDir = join(tmpDir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "teams.yaml"),
      `my-team:
  description: "My team"
  workspaceMode: shared
  maxConcurrency: 2
  members:
    - researcher
    - unknown-agent
`,
    );

    const agents = [fakeAgent("researcher")];
    const teams = loadTeams(tmpDir, agents);

    expect(Object.keys(teams)).toEqual(["my-team"]);
    expect(teams["my-team"].members).toEqual(["researcher"]);
    // unknown-agent was filtered out
    expect(teams["my-team"].maxConcurrency).toBe(2);
    expect(teams["my-team"].workspaceMode).toBe("shared");
  });

  it("skips teams with no valid members", () => {
    const agentsDir = join(tmpDir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "teams.yaml"),
      `empty-team:
  description: "No valid members"
  workspaceMode: shared
  maxConcurrency: 1
  members:
    - nonexistent
`,
    );

    const teams = loadTeams(tmpDir, [fakeAgent("researcher")]);
    expect(Object.keys(teams)).toEqual([]);
  });

  it("returns empty when teams.yaml is missing", () => {
    expect(loadTeams(tmpDir, [fakeAgent("researcher")])).toEqual({});
  });

  it("defaults workspaceMode to shared and maxConcurrency to 1", () => {
    const agentsDir = join(tmpDir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "teams.yaml"),
      `minimal:
  description: "Minimal config"
  members:
    - alpha
`,
    );

    const teams = loadTeams(tmpDir, [fakeAgent("alpha")]);
    expect(teams["minimal"].workspaceMode).toBe("shared");
    expect(teams["minimal"].maxConcurrency).toBe(1);
  });
});
