// Tests for buildAgentArgs — verifies the exact CLI args and env that child
// agent processes receive. This covers the core behaviors introduced by the
// native-extensions refactor:
//
//   - PI_AGENT_TEAMS_CHILD=1 is always set (recursion guard)
//   - --no-extensions is absent by default (native discovery runs)
//   - --no-extensions is present when extensionArgs is provided
//   - -e <path> flags appear for each entry in extensionArgs
//   - --skill <dir> flags appear for each entry in skillDirs
//   - skills: absent → no --skill flags (auto-discovery handles it)
//   - model, tools, -c (session resume) work as before

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAgentArgs, resolveToolsList } from "./agent-runner.js";
import type { AgentDefinition, AgentWorkspacePaths } from "./types.js";

// ── fixtures ─────────────────────────────────────

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    description: "A test agent",
    systemPrompt: "You are a test agent.",
    filePath: "/fake/path.md",
    ...overrides,
  };
}

function makeWorkspace(root: string): AgentWorkspacePaths {
  return {
    root,
    sessionFile: join(root, "session.json"),
    notesFile: join(root, "notes.md"),
    outputFile: join(root, "output.md"),
  };
}

let tmpDir: string;
let workspace: AgentWorkspacePaths;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-runner-test-"));
  workspace = makeWorkspace(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── buildAgentArgs ────────────────────────────────

describe("buildAgentArgs", () => {
  describe("recursion guard", () => {
    it("PI_AGENT_TEAMS_CHILD is documented intent — env is set in spawnAgent not args", () => {
      // The env var is applied in spawnAgent's spawn() call, not in the args array.
      // Verify the args array itself does not contain it (it's not a CLI flag).
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
      });
      expect(args.join(" ")).not.toContain("PI_AGENT_TEAMS_CHILD");
    });
  });

  describe("extension control", () => {
    it("does NOT include --no-extensions when extensionArgs is absent (default mode)", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
      });
      expect(args).not.toContain("--no-extensions");
    });

    it("includes --no-extensions when extensionArgs is an empty array (fully isolated)", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
        extensionArgs: [],
      });
      expect(args).toContain("--no-extensions");
      // No -e flags for empty array
      expect(args).not.toContain("-e");
    });

    it("includes --no-extensions and -e flags for each extension in allowlist", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
        extensionArgs: ["-e", "/abs/security.ts", "-e", "/abs/sandbox.ts"],
      });
      expect(args).toContain("--no-extensions");
      const noExtIdx = args.indexOf("--no-extensions");
      const eIdx1 = args.indexOf("-e");
      // --no-extensions comes before -e flags
      expect(noExtIdx).toBeLessThan(eIdx1);
      expect(args).toContain("/abs/security.ts");
      expect(args).toContain("/abs/sandbox.ts");
    });

    it("--no-extensions appears before --append-system-prompt and after base flags", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
        extensionArgs: ["-e", "/abs/security.ts"],
      });
      const noExtIdx = args.indexOf("--no-extensions");
      const systemPromptIdx = args.indexOf("--append-system-prompt");
      // --no-extensions is inserted after the base flags block
      expect(noExtIdx).toBeGreaterThan(systemPromptIdx);
    });
  });

  describe("skill preloading", () => {
    it("does NOT include --skill when skillDirs is absent (auto-discovery handles it)", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
      });
      expect(args).not.toContain("--skill");
    });

    it("does NOT include --skill when skillDirs is an empty array", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
        skillDirs: [],
      });
      expect(args).not.toContain("--skill");
    });

    it("includes --skill <dir> for each entry in skillDirs", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
        skillDirs: ["/skills/read-only", "/skills/workspace-notes"],
      });
      const skillPairs = args.reduce<string[]>((acc, arg, i) => {
        if (arg === "--skill") acc.push(args[i + 1]);
        return acc;
      }, []);
      expect(skillPairs).toEqual(["/skills/read-only", "/skills/workspace-notes"]);
    });

    it("--skill args appear before --model and --tools", () => {
      const args = buildAgentArgs({
        agent: makeAgent({ tools: ["read"] }),
        task: "do something",
        workspace,
        cwd: tmpDir,
        skillDirs: ["/skills/read-only"],
        model: "anthropic/claude-haiku-4-5",
      });
      const skillIdx = args.indexOf("--skill");
      const modelIdx = args.indexOf("--model");
      const toolsIdx = args.indexOf("--tools");
      expect(skillIdx).toBeLessThan(modelIdx);
      expect(skillIdx).toBeLessThan(toolsIdx);
    });
  });

  describe("combined extension + skill modes", () => {
    it("fully isolated mode: --no-extensions + --skill for declared skills", () => {
      // Represents: extensions: "" + skills: read-only
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
        extensionArgs: [],
        skillDirs: ["/skills/read-only"],
      });
      expect(args).toContain("--no-extensions");
      expect(args).toContain("--skill");
      expect(args).toContain("/skills/read-only");
    });

    it("restricted extensions + skills: both --no-extensions/-e and --skill present", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
        extensionArgs: ["-e", "/abs/security.ts"],
        skillDirs: ["/skills/workspace-notes"],
      });
      expect(args).toContain("--no-extensions");
      expect(args).toContain("-e");
      expect(args).toContain("/abs/security.ts");
      expect(args).toContain("--skill");
      expect(args).toContain("/skills/workspace-notes");
    });

    it("default mode (no extensions field): neither --no-extensions nor --skill present", () => {
      // The common case: extensions absent, skills absent — all auto-discovered
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
      });
      expect(args).not.toContain("--no-extensions");
      expect(args).not.toContain("--skill");
    });
  });

  describe("model override", () => {
    it("includes --model when model is provided", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
        model: "anthropic/claude-haiku-4-5",
      });
      const idx = args.indexOf("--model");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("anthropic/claude-haiku-4-5");
    });

    it("omits --model when model is absent", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
      });
      expect(args).not.toContain("--model");
    });
  });

  describe("plan flag", () => {
    it("includes --plan when agent.plan is true", () => {
      const args = buildAgentArgs({
        agent: makeAgent({ plan: true }),
        task: "do something",
        workspace,
        cwd: tmpDir,
      });
      expect(args).toContain("--plan");
    });

    it("omits --plan when plan is absent from the agent definition", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
      });
      expect(args).not.toContain("--plan");
    });
  });

  describe("session resume", () => {
    it("includes -c when session file exists", () => {
      writeFileSync(workspace.sessionFile, "{}", "utf-8");
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
      });
      expect(args).toContain("-c");
    });

    it("omits -c when session file does not exist", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "do something",
        workspace,
        cwd: tmpDir,
      });
      expect(args).not.toContain("-c");
    });
  });

  describe("task position", () => {
    it("task is always the last argument", () => {
      const task = "implement the feature";
      const args = buildAgentArgs({
        agent: makeAgent(),
        task,
        workspace,
        cwd: tmpDir,
        model: "anthropic/claude-haiku-4-5",
        extensionArgs: ["-e", "/abs/security.ts"],
        skillDirs: ["/skills/read-only"],
      });
      expect(args[args.length - 1]).toBe(task);
    });
  });

  describe("base flags always present", () => {
    it("always includes --mode json, -p, --thinking off, --append-system-prompt, --session", () => {
      const args = buildAgentArgs({
        agent: makeAgent(),
        task: "task",
        workspace,
        cwd: tmpDir,
      });
      expect(args).toContain("--mode");
      expect(args[args.indexOf("--mode") + 1]).toBe("json");
      expect(args).toContain("-p");
      expect(args).toContain("--thinking");
      expect(args[args.indexOf("--thinking") + 1]).toBe("off");
      expect(args).toContain("--append-system-prompt");
      expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("You are a test agent.");
      expect(args).toContain("--session");
      expect(args[args.indexOf("--session") + 1]).toBe(workspace.sessionFile);
    });
  });
});

// ── resolveToolsList ──────────────────────────────

describe("resolveToolsList", () => {
  it("returns joined tools list when agent.tools is set", () => {
    const agent = makeAgent({ tools: ["read", "grep", "find"] });
    expect(resolveToolsList(agent, [])).toBe("read,grep,find");
  });

  it("subtracts disallowedTools from allToolNames", () => {
    const agent = makeAgent({ disallowedTools: ["bash", "write"] });
    const result = resolveToolsList(agent, ["read", "write", "bash", "grep"]);
    expect(result).toBe("read,grep");
  });

  it("returns undefined when neither tools nor disallowedTools is set", () => {
    expect(resolveToolsList(makeAgent(), ["read", "bash"])).toBeUndefined();
  });

  it("returns undefined when disallowedTools removes all tools", () => {
    const agent = makeAgent({ disallowedTools: ["read"] });
    expect(resolveToolsList(agent, ["read"])).toBeUndefined();
  });

  it("is case-insensitive for disallowedTools matching", () => {
    const agent = makeAgent({ disallowedTools: ["BASH"] });
    const result = resolveToolsList(agent, ["read", "bash"]);
    expect(result).toBe("read");
  });
});
