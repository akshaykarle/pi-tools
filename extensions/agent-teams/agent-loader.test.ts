import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  parseFrontmatter: <T extends Record<string, unknown>>(
    content: string,
  ): { frontmatter: T; body: string } => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { frontmatter: {} as T, body: content };
    const frontmatter: Record<string, unknown> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return { frontmatter: frontmatter as T, body: match[2] };
  },
}));

import { loadAgentDefinitions, parseAgentFile } from "./agent-loader.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-loader-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseAgentFile", () => {
  it("parses a valid agent file", () => {
    const filePath = join(tmpDir, "researcher.md");
    writeFileSync(
      filePath,
      `---
name: researcher
description: Explores codebases
tools: read,grep,find,ls
---
You are a research specialist.
`,
    );

    const def = parseAgentFile(filePath);
    expect(def).not.toBeNull();
    expect(def!.name).toBe("researcher");
    expect(def!.description).toBe("Explores codebases");
    expect(def!.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(def!.disallowedTools).toBeUndefined();
    expect(def!.systemPrompt).toBe("You are a research specialist.");
  });

  it("parses model and skills", () => {
    const filePath = join(tmpDir, "smart-agent.md");
    writeFileSync(
      filePath,
      `---
name: smart-agent
model: anthropic/claude-sonnet-4
skills: safe-bash, workspace-notes
---
You are smart.
`,
    );

    const def = parseAgentFile(filePath);
    expect(def).not.toBeNull();
    expect(def!.model).toBe("anthropic/claude-sonnet-4");
    expect(def!.skills).toEqual(["safe-bash", "workspace-notes"]);
  });

  it("leaves model and skills undefined when absent", () => {
    const filePath = join(tmpDir, "plain-agent.md");
    writeFileSync(
      filePath,
      `---
name: plain-agent
---
Just a plain agent.
`,
    );

    const def = parseAgentFile(filePath);
    expect(def).not.toBeNull();
    expect(def!.model).toBeUndefined();
    expect(def!.skills).toBeUndefined();
  });

  it("parses disallowedTools", () => {
    const filePath = join(tmpDir, "safe-agent.md");
    writeFileSync(
      filePath,
      `---
name: safe-agent
disallowedTools: bash,write,edit
---
You are safe.
`,
    );

    const def = parseAgentFile(filePath);
    expect(def).not.toBeNull();
    expect(def!.tools).toBeUndefined();
    expect(def!.disallowedTools).toEqual(["bash", "write", "edit"]);
  });

  it("returns null when both tools and disallowedTools are set", () => {
    const filePath = join(tmpDir, "bad.md");
    writeFileSync(
      filePath,
      `---
name: bad
tools: read
disallowedTools: bash
---
Body.
`,
    );
    expect(parseAgentFile(filePath)).toBeNull();
  });

  it("returns null when name is missing", () => {
    const filePath = join(tmpDir, "noname.md");
    writeFileSync(
      filePath,
      `---
description: No name
---
Body.
`,
    );
    expect(parseAgentFile(filePath)).toBeNull();
  });

  it("returns null for non-existent file", () => {
    expect(parseAgentFile(join(tmpDir, "nope.md"))).toBeNull();
  });
});

describe("loadAgentDefinitions", () => {
  it("loads all valid agents from .pi/agents/", () => {
    const agentsDir = join(tmpDir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "a.md"),
      `---
name: alpha
description: Agent A
tools: read
---
Alpha prompt.
`,
    );
    writeFileSync(
      join(agentsDir, "b.md"),
      `---
name: beta
description: Agent B
---
Beta prompt.
`,
    );
    // non-md file should be ignored
    writeFileSync(join(agentsDir, "teams.yaml"), "some-team:\n  members:\n    - alpha\n");

    const agents = loadAgentDefinitions(tmpDir);
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("deduplicates by name (first wins)", () => {
    const agentsDir = join(tmpDir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "a.md"),
      `---
name: dup
description: First
---
First.
`,
    );
    writeFileSync(
      join(agentsDir, "b.md"),
      `---
name: dup
description: Second
---
Second.
`,
    );

    const agents = loadAgentDefinitions(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].description).toBe("First");
  });

  it("returns empty array when .pi/agents/ does not exist", () => {
    expect(loadAgentDefinitions(tmpDir)).toEqual([]);
  });
});
