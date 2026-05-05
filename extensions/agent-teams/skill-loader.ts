// Agent Teams — skill loading and injection for child agents.
//
// Skills are reusable `SKILL.md` snippets injected into an agent's system prompt.
// Discovery uses the `pi.skills` directories declared in the project's `package.json`,
// so agent skills are drawn from the same pool as parent-session skills.
//
// Directory layout (project-first precedence):
//   ./skills/<name>/SKILL.md
//   node_modules/<pkg>/skills/<name>/SKILL.md
//   ... (any other paths listed in package.json -> pi.skills)

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

/**
 * Read the `pi.skills` directories from the project's `package.json`.
 * Returns resolved absolute paths. Returns an empty array if the field is
 * absent or the file cannot be read.
 */
export function readPiSkillDirs(cwd: string): string[] {
  const pkgPath = join(cwd, "package.json");
  try {
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const piField = pkg["pi"] as Record<string, unknown> | undefined;
    const skillsField = piField?.["skills"];
    if (!Array.isArray(skillsField)) return [];
    return skillsField
      .filter((s): s is string => typeof s === "string")
      .map((s) => resolve(cwd, s));
  } catch {
    return [];
  }
}

/**
 * Load a single skill by name from the given skill directories.
 * Searches each directory for `<name>/SKILL.md` in order, returning the
 * body of the first match (frontmatter stripped). Returns `null` if the
 * skill is not found in any directory.
 */
export function loadSkill(skillDirs: string[], name: string): string | null {
  for (const dir of skillDirs) {
    const skillPath = join(dir, name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    try {
      const raw = readFileSync(skillPath, "utf-8");
      const { body } = parseFrontmatter(raw);
      return body.trim();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve a list of skill names to their formatted injection text.
 *
 * Each found skill is wrapped in an XML block:
 *   <skill name="safe-bash">
 *   ...content...
 *   </skill>
 *
 * Returns:
 *  - `text`: all found skills joined with blank lines (empty string if none found)
 *  - `missing`: names of skills that could not be found in any skill directory
 */
export function resolveSkills(
  cwd: string,
  skillNames: string[],
): { text: string; missing: string[] } {
  if (skillNames.length === 0) return { text: "", missing: [] };

  const skillDirs = readPiSkillDirs(cwd);
  const blocks: string[] = [];
  const missing: string[] = [];

  for (const name of skillNames) {
    const body = loadSkill(skillDirs, name);
    if (body === null) {
      missing.push(name);
    } else {
      blocks.push(`<skill name="${name}">\n${body}\n</skill>`);
    }
  }

  return {
    text: blocks.join("\n\n"),
    missing,
  };
}
