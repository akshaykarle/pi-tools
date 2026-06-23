// Agent Teams — load agent definitions from `.pi/agents/*.md` files.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./types.js";

/** Expected frontmatter shape in agent `.md` files. */
interface AgentFrontmatter {
  [key: string]: unknown;
  name: string;
  description?: string;
  tools?: string | string[];
  disallowedTools?: string | string[];
  model?: string;
  skills?: string | string[];
  extensions?: string | string[];
  plan?: string | boolean;
}

/**
 * Parse a comma-separated tool string (or YAML-parsed string array) into a
 * trimmed array.  Returns undefined when the input is falsy.
 */
function parseToolList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  // YAML may already have parsed the value as an array.
  if (Array.isArray(raw)) {
    const result = raw.map((t) => String(t).trim()).filter(Boolean);
    return result.length ? result : undefined;
  }
  if (typeof raw !== "string") return undefined;
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

  const tools = parseToolList(frontmatter.tools);
  const disallowedTools = parseToolList(frontmatter.disallowedTools);

  if (tools && disallowedTools) {
    // Mutually exclusive — prefer tools (allowlist).
    return null;
  }

  const skills = parseToolList(frontmatter.skills);

  // `extensions` is tri-state: undefined = absent (all extensions), [] = empty string
  // (--no-extensions), or a non-empty array (allowlist).
  const rawExtensions = frontmatter.extensions;
  const extensions: string[] | undefined =
    rawExtensions === undefined
      ? undefined                            // absent — all extensions load
      : (parseToolList(rawExtensions) ?? []); // empty string/[] → [], list → array

  // `plan` is true when the frontmatter value is the string 'true' or boolean true.
  const rawPlan = frontmatter.plan as string | boolean | undefined;
  const plan: boolean | undefined =
    rawPlan === true || rawPlan === "true" ? true : undefined;

  return {
    name: frontmatter.name,
    description: frontmatter.description ?? "",
    tools,
    disallowedTools,
    model: frontmatter.model as string | undefined,
    skills,
    extensions,
    plan,
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
