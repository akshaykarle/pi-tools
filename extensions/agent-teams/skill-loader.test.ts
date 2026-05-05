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

import { loadSkill, readPiSkillDirs, resolveSkills } from "./skill-loader.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "skill-loader-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────

function writeSkill(dir: string, name: string, content: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");
}

function writePackageJson(cwd: string, skillPaths: string[]): void {
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ pi: { skills: skillPaths } }),
    "utf-8",
  );
}

// ── readPiSkillDirs ──────────────────────────────

describe("readPiSkillDirs", () => {
  it("returns resolved paths from package.json pi.skills", () => {
    writePackageJson(tmpDir, ["./skills", "node_modules/some-pkg/skills"]);
    const dirs = readPiSkillDirs(tmpDir);
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toMatch(/skills$/);
    expect(dirs[1]).toMatch(/some-pkg\/skills$/);
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
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ pi: { skills: ["./skills", 42, null] } }),
      "utf-8",
    );
    const dirs = readPiSkillDirs(tmpDir);
    expect(dirs).toHaveLength(1);
  });
});

// ── loadSkill ────────────────────────────────────

describe("loadSkill", () => {
  it("finds a skill in the first directory", () => {
    const skillsDir = join(tmpDir, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "safe-bash", "---\nname: safe-bash\n---\nBe careful with bash.\n");

    const result = loadSkill([skillsDir], "safe-bash");
    expect(result).toBe("Be careful with bash.");
  });

  it("finds a skill in the second directory when absent from first", () => {
    const dir1 = join(tmpDir, "skills1");
    const dir2 = join(tmpDir, "skills2");
    mkdirSync(dir1);
    mkdirSync(dir2);
    writeSkill(dir2, "my-skill", "---\nname: my-skill\n---\nSkill content.\n");

    const result = loadSkill([dir1, dir2], "my-skill");
    expect(result).toBe("Skill content.");
  });

  it("prefers first directory when skill exists in both", () => {
    const dir1 = join(tmpDir, "skills1");
    const dir2 = join(tmpDir, "skills2");
    mkdirSync(dir1);
    mkdirSync(dir2);
    writeSkill(dir1, "shared", "---\nname: shared\n---\nFrom dir1.\n");
    writeSkill(dir2, "shared", "---\nname: shared\n---\nFrom dir2.\n");

    const result = loadSkill([dir1, dir2], "shared");
    expect(result).toBe("From dir1.");
  });

  it("strips frontmatter and returns only body", () => {
    const skillsDir = join(tmpDir, "skills");
    mkdirSync(skillsDir);
    writeSkill(
      skillsDir,
      "annotated",
      "---\nname: annotated\ndescription: Has frontmatter\n---\nActual content here.\n",
    );

    const result = loadSkill([skillsDir], "annotated");
    expect(result).toBe("Actual content here.");
    expect(result).not.toContain("frontmatter");
  });

  it("returns null when skill is not found in any directory", () => {
    const skillsDir = join(tmpDir, "skills");
    mkdirSync(skillsDir);
    expect(loadSkill([skillsDir], "nonexistent")).toBeNull();
  });

  it("returns null for empty directory list", () => {
    expect(loadSkill([], "any-skill")).toBeNull();
  });
});

// ── resolveSkills ────────────────────────────────

describe("resolveSkills", () => {
  beforeEach(() => {
    const skillsDir = join(tmpDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeSkill(skillsDir, "safe-bash", "---\nname: safe-bash\n---\nBe careful with bash.\n");
    writeSkill(skillsDir, "read-only", "---\nname: read-only\n---\nNever modify files.\n");
    writePackageJson(tmpDir, ["./skills"]);
  });

  it("returns empty text and no missing for empty skill list", () => {
    const result = resolveSkills(tmpDir, []);
    expect(result.text).toBe("");
    expect(result.missing).toEqual([]);
  });

  it("wraps a single skill in XML tags", () => {
    const result = resolveSkills(tmpDir, ["safe-bash"]);
    expect(result.text).toBe(
      '<skill name="safe-bash">\nBe careful with bash.\n</skill>',
    );
    expect(result.missing).toEqual([]);
  });

  it("joins multiple skills with blank lines", () => {
    const result = resolveSkills(tmpDir, ["safe-bash", "read-only"]);
    expect(result.text).toContain('<skill name="safe-bash">');
    expect(result.text).toContain('<skill name="read-only">');
    expect(result.text).toContain("\n\n");
    expect(result.missing).toEqual([]);
  });

  it("reports missing skills without failing", () => {
    const result = resolveSkills(tmpDir, ["safe-bash", "nonexistent"]);
    expect(result.missing).toEqual(["nonexistent"]);
    expect(result.text).toContain('<skill name="safe-bash">');
    expect(result.text).not.toContain("nonexistent");
  });

  it("returns all as missing when no skill dirs are configured", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({}), "utf-8");
    const result = resolveSkills(tmpDir, ["safe-bash", "read-only"]);
    expect(result.missing).toEqual(["safe-bash", "read-only"]);
    expect(result.text).toBe("");
  });
});
