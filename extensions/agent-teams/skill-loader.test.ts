import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findSkillDir, readPiExtensionPaths, readPiSkillDirs } from "./skill-loader.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "skill-loader-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────

function writeSkill(dir: string, name: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\nContent.\n`);
}

function writePackageJson(cwd: string, pi: Record<string, unknown>): void {
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ pi }), "utf-8");
}

// ── readPiSkillDirs ──────────────────────────────

describe("readPiSkillDirs", () => {
  it("returns resolved paths from package.json pi.skills", () => {
    writePackageJson(tmpDir, { skills: ["./skills", "node_modules/some-pkg/skills"] });
    const dirs = readPiSkillDirs(tmpDir);
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toBe(resolve(tmpDir, "./skills"));
    expect(dirs[1]).toBe(resolve(tmpDir, "node_modules/some-pkg/skills"));
  });

  it("returns empty array when pi.skills field is absent", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
    expect(readPiSkillDirs(tmpDir)).toEqual([]);
  });

  it("returns empty array when package.json does not exist", () => {
    expect(readPiSkillDirs(tmpDir)).toEqual([]);
  });

  it("returns empty array when package.json is invalid JSON", () => {
    writeFileSync(join(tmpDir, "package.json"), "not json", "utf-8");
    expect(readPiSkillDirs(tmpDir)).toEqual([]);
  });

  it("filters out non-string entries", () => {
    writePackageJson(tmpDir, { skills: ["./skills", 42, null] });
    const dirs = readPiSkillDirs(tmpDir);
    expect(dirs).toHaveLength(1);
  });
});

// ── findSkillDir ─────────────────────────────────

describe("findSkillDir", () => {
  it("finds a skill in the first directory", () => {
    const skillsDir = join(tmpDir, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "safe-bash");

    const result = findSkillDir([skillsDir], "safe-bash");
    expect(result).toBe(join(skillsDir, "safe-bash"));
  });

  it("finds a skill in the second directory when absent from first", () => {
    const dir1 = join(tmpDir, "skills1");
    const dir2 = join(tmpDir, "skills2");
    mkdirSync(dir1);
    mkdirSync(dir2);
    writeSkill(dir2, "my-skill");

    const result = findSkillDir([dir1, dir2], "my-skill");
    expect(result).toBe(join(dir2, "my-skill"));
  });

  it("prefers first directory when skill exists in both", () => {
    const dir1 = join(tmpDir, "skills1");
    const dir2 = join(tmpDir, "skills2");
    mkdirSync(dir1);
    mkdirSync(dir2);
    writeSkill(dir1, "shared");
    writeSkill(dir2, "shared");

    const result = findSkillDir([dir1, dir2], "shared");
    expect(result).toBe(join(dir1, "shared"));
  });

  it("returns null when skill directory exists but has no SKILL.md", () => {
    const skillsDir = join(tmpDir, "skills");
    mkdirSync(join(skillsDir, "empty-skill"), { recursive: true });
    expect(findSkillDir([skillsDir], "empty-skill")).toBeNull();
  });

  it("returns null when skill is not found in any directory", () => {
    const skillsDir = join(tmpDir, "skills");
    mkdirSync(skillsDir);
    expect(findSkillDir([skillsDir], "nonexistent")).toBeNull();
  });

  it("returns null for empty directory list", () => {
    expect(findSkillDir([], "any-skill")).toBeNull();
  });
});

// ── readPiExtensionPaths ─────────────────────────

describe("readPiExtensionPaths", () => {
  it("maps basename-without-ext (lowercase) to absolute path", () => {
    writePackageJson(tmpDir, {
      extensions: [
        "./extensions/security.ts",
        "./extensions/sandbox.ts",
        "./extensions/agent-teams.ts",
      ],
    });
    const paths = readPiExtensionPaths(tmpDir);
    expect(paths["security"]).toBe(resolve(tmpDir, "./extensions/security.ts"));
    expect(paths["sandbox"]).toBe(resolve(tmpDir, "./extensions/sandbox.ts"));
    expect(paths["agent-teams"]).toBe(resolve(tmpDir, "./extensions/agent-teams.ts"));
  });

  it("lowercases the key", () => {
    writePackageJson(tmpDir, { extensions: ["./extensions/Security.ts"] });
    const paths = readPiExtensionPaths(tmpDir);
    expect(paths["security"]).toBeDefined();
    expect(paths["Security"]).toBeUndefined();
  });

  it("handles extensions without .ts extension (e.g. directory index)", () => {
    writePackageJson(tmpDir, { extensions: ["node_modules/@plannotator/pi-extension"] });
    const paths = readPiExtensionPaths(tmpDir);
    expect(paths["pi-extension"]).toBeDefined();
  });

  it("returns empty object when pi.extensions is absent", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
    expect(readPiExtensionPaths(tmpDir)).toEqual({});
  });

  it("returns empty object when package.json does not exist", () => {
    expect(readPiExtensionPaths(tmpDir)).toEqual({});
  });

  it("returns empty object when package.json is invalid JSON", () => {
    writeFileSync(join(tmpDir, "package.json"), "not json", "utf-8");
    expect(readPiExtensionPaths(tmpDir)).toEqual({});
  });

  it("filters out non-string entries", () => {
    writePackageJson(tmpDir, { extensions: ["./extensions/security.ts", 42, null] });
    const paths = readPiExtensionPaths(tmpDir);
    expect(Object.keys(paths)).toHaveLength(1);
    expect(paths["security"]).toBeDefined();
  });
});
