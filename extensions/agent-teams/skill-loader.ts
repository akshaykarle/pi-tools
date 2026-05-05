// Agent Teams — skill and extension path resolution for child agent spawning.
//
// Skills are discovered natively by the child pi process via progressive disclosure.
// This module handles two things:
//
//   1. Resolving declared skill names to directory paths for `--skill <dir>` force-preloading.
//      This ensures skills are available even when `--no-extensions` suppresses
//      package-declared skill discovery paths.
//
//   2. Resolving declared extension names to absolute paths for `-e <path>` selective loading.
//      Used when an agent frontmatter declares `extensions: security, sandbox` to restrict
//      which extensions the child process loads.
//
// Both rely on reading the project's `package.json` for configuration.

import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

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
 * Find the directory path for a skill by name.
 * Searches each skill directory for a subdirectory named `<name>` containing
 * a `SKILL.md` file. Returns the first match (project-first precedence).
 * Returns `null` if the skill is not found in any directory.
 *
 * The returned path is the skill's parent directory (not the SKILL.md file),
 * suitable for passing to `--skill <dir>`.
 */
export function findSkillDir(skillDirs: string[], name: string): string | null {
  for (const dir of skillDirs) {
    const skillDir = join(dir, name);
    if (existsSync(join(skillDir, "SKILL.md"))) {
      return skillDir;
    }
  }
  return null;
}

/**
 * Read the `pi.extensions` list from the project's `package.json` and return
 * a map of `{ lowercased-basename-without-ext → absolute-path }`.
 *
 * For example, `"./extensions/security.ts"` maps to `"security"`.
 * Used to resolve agent frontmatter `extensions: security, sandbox` to
 * absolute paths for `-e <path>` child process args.
 *
 * Returns an empty object if the field is absent or the file cannot be read.
 */
export function readPiExtensionPaths(cwd: string): Record<string, string> {
  const pkgPath = join(cwd, "package.json");
  try {
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const piField = pkg["pi"] as Record<string, unknown> | undefined;
    const extsField = piField?.["extensions"];
    if (!Array.isArray(extsField)) return {};
    const result: Record<string, string> = {};
    for (const entry of extsField) {
      if (typeof entry !== "string") continue;
      const absPath = resolve(cwd, entry);
      const name = basename(entry, extname(entry)).toLowerCase();
      result[name] = absPath;
    }
    return result;
  } catch {
    return {};
  }
}
