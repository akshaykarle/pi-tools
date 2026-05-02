// Agent Teams — load agent definitions from `.pi/agents/*.md` files.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "./types.js";

/** Expected frontmatter shape in agent `.md` files. */
interface AgentFrontmatter {
  name: string;
  description?: string;
  tools?: string;
  disallowedTools?: string;
}

/**
 * Parse a comma-separated tool string into a trimmed array.
 * Returns undefined when the input is falsy.
 */
function parseToolList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Parse a single agent markdown file into an AgentDefinition.
 * Returns `null` when the file is invalid or missing required fields.
 */
export function parseAgentFile(filePath: string): AgentDefinition | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(raw);

  if (!frontmatter.name) return null;

  const tools = parseToolList(frontmatter.tools as string | undefined);
  const disallowedTools = parseToolList(
    frontmatter.disallowedTools as string | undefined,
  );

  if (tools && disallowedTools) {
    // Mutually exclusive — prefer tools (allowlist).
    return null;
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description ?? "",
    tools,
    disallowedTools,
    systemPrompt: body.trim(),
    filePath,
  };
}

/**
 * Scan `.pi/agents/` for `*.md` files and return all valid agent definitions.
 * Agents are de-duplicated by name (first occurrence wins).
 */
export function loadAgentDefinitions(cwd: string): AgentDefinition[] {
  const agentsDir = join(cwd, ".pi", "agents");
  const agents: AgentDefinition[] = [];
  const seen = new Set<string>();

  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const fullPath = resolve(agentsDir, entry);
    const def = parseAgentFile(fullPath);
    if (!def) continue;
    const key = def.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    agents.push(def);
  }

  return agents;
}
