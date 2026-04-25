import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandPath,
  isReadBlocked,
  isUnderDirectory,
  isWriteBlocked,
  matchesFilePattern,
} from "./path-guard.js";

describe("expandPath", () => {
  const cwd = "/work";

  it("expands bare ~ to homedir", () => {
    expect(expandPath("~", cwd)).toBe(resolve(homedir(), ""));
  });

  it("expands ~/foo/bar to ${homedir}/foo/bar", () => {
    expect(expandPath("~/foo/bar", cwd)).toBe(resolve(homedir(), "foo/bar"));
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandPath("/abs/path", cwd)).toBe("/abs/path");
  });

  it("resolves ./rel against cwd", () => {
    expect(expandPath("./rel", cwd)).toBe(resolve(cwd, "./rel"));
  });

  it("resolves bare relative path against cwd", () => {
    expect(expandPath("rel", cwd)).toBe(resolve(cwd, "rel"));
  });

  it("treats ~foo (no slash after ~) as relative, NOT homedir", () => {
    // "~foo" does not match "~" or start with "~/" — falls through to relative.
    expect(expandPath("~foo", cwd)).toBe(resolve(cwd, "~foo"));
  });
});

describe("isUnderDirectory", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pg-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns true for exact match", () => {
    expect(isUnderDirectory("/home/user/.ssh", "/home/user/.ssh")).toBe(true);
  });

  it("returns true for true prefix with trailing slash boundary", () => {
    expect(isUnderDirectory("/home/user/.ssh/id_rsa", "/home/user/.ssh")).toBe(true);
  });

  it("returns false for sibling with shared prefix (not a true subdir)", () => {
    // Critical: /home/user/.sshkeys is NOT under /home/user/.ssh.
    expect(isUnderDirectory("/home/user/.sshkeys", "/home/user/.ssh")).toBe(false);
  });

  it("handles root dir as a special case", () => {
    expect(isUnderDirectory("/foo", "/")).toBe(true);
  });

  it("follows symlink for file under allowed dir via realpath", () => {
    const target = join(tmp, "real");
    mkdirSync(target);
    const file = join(target, "secret");
    writeFileSync(file, "x");
    const link = join(tmp, "link");
    symlinkSync(target, link);

    expect(isUnderDirectory(join(link, "secret"), target)).toBe(true);
  });

  it("follows symlink for file under denied dir via realpath", () => {
    const deny = join(tmp, "deny");
    mkdirSync(deny);
    const link = join(tmp, "alias-to-deny");
    symlinkSync(deny, link);

    // Prefix match via the symlinked path already returns true before realpath.
    expect(isUnderDirectory(join(link, "a"), link)).toBe(true);

    // And the realpath branch handles a divergent prefix case:
    const realFile = join(deny, "b");
    writeFileSync(realFile, "x");
    expect(isUnderDirectory(realFile, link)).toBe(true);
  });

  it("uses string fallback when path does not exist", () => {
    expect(isUnderDirectory("/nonexistent/foo/bar", "/nonexistent/foo")).toBe(true);
    expect(isUnderDirectory("/nonexistent/other", "/nonexistent/foo")).toBe(false);
  });
});

describe("matchesFilePattern", () => {
  it("matches literal .env exactly (and not .env.local)", () => {
    expect(matchesFilePattern("/a/b/.env", ".env")).toBe(true);
    expect(matchesFilePattern("/a/b/.env.local", ".env")).toBe(false);
  });

  it("matches suffix glob *.pem", () => {
    expect(matchesFilePattern("/a/key.pem", "*.pem")).toBe(true);
    expect(matchesFilePattern("/a/foo.pem", "*.pem")).toBe(true);
    expect(matchesFilePattern("/a/pem", "*.pem")).toBe(false);
    expect(matchesFilePattern("/a/pem.txt", "*.pem")).toBe(false);
  });

  it("matches prefix glob .env.*", () => {
    expect(matchesFilePattern("/a/.env.local", ".env.*")).toBe(true);
    expect(matchesFilePattern("/a/.env.prod", ".env.*")).toBe(true);
    expect(matchesFilePattern("/a/.env", ".env.*")).toBe(false);
    expect(matchesFilePattern("/a/env.local", ".env.*")).toBe(false);
  });

  it("documents behavior for both-ends wildcard: suffix branch wins and * is literal in filename", () => {
    // Pattern "*.env.*" starts with "*" so the suffix branch fires:
    // the trailing literal `.env.*` (with a literal asterisk) must appear at the end.
    // Real-world filenames do not contain literal `*`, so this pattern is effectively dead.
    expect(matchesFilePattern("/a/x.env.local", "*.env.*")).toBe(false);
    expect(matchesFilePattern("/a/x.env.", "*.env.*")).toBe(false);
    // Only a filename with a literal asterisk in it would match:
    expect(matchesFilePattern("/a/x.env.*", "*.env.*")).toBe(true);
  });
});

describe("isReadBlocked", () => {
  const cwd = "/work";

  it("returns blocked:false when denyRead is missing or empty", () => {
    expect(isReadBlocked("/any/path", {}, cwd).blocked).toBe(false);
    expect(isReadBlocked("/any/path", { filesystem: { denyRead: [] } }, cwd).blocked).toBe(false);
  });

  it("blocks a path under a denied directory", () => {
    const result = isReadBlocked("/home/user/.ssh/id_rsa", {
      filesystem: { denyRead: ["/home/user/.ssh"] },
    }, cwd);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("/home/user/.ssh");
  });

  it("expands ~ in denyRead patterns when evaluating", () => {
    const target = join(homedir(), ".ssh/id_rsa");
    const result = isReadBlocked(target, {
      filesystem: { denyRead: ["~/.ssh"] },
    }, cwd);
    expect(result.blocked).toBe(true);
  });

  it("does NOT block a sibling directory with shared prefix", () => {
    const result = isReadBlocked("/home/user/.sshkeys/x", {
      filesystem: { denyRead: ["/home/user/.ssh"] },
    }, cwd);
    expect(result.blocked).toBe(false);
  });
});

describe("isWriteBlocked", () => {
  const cwd = "/work";

  it("returns blocked:false when no filesystem config is set", () => {
    expect(isWriteBlocked("/any/path", {}, cwd).blocked).toBe(false);
  });

  it("denyWrite pattern takes precedence over allowWrite", () => {
    const result = isWriteBlocked("/work/.env.local", {
      filesystem: {
        allowWrite: ["/work"],
        denyWrite: [".env.*"],
      },
    }, cwd);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("matches restricted pattern");
  });

  it("defaults to deny when allowWrite is missing or empty", () => {
    expect(isWriteBlocked("/work/file", {
      filesystem: { denyWrite: [] },
    }, cwd).blocked).toBe(true);
    expect(isWriteBlocked("/work/file", {
      filesystem: { allowWrite: [], denyWrite: [] },
    }, cwd).blocked).toBe(true);
  });

  it("allows a path nested under an allowWrite dir when no denyWrite matches", () => {
    const result = isWriteBlocked("/work/src/file.ts", {
      filesystem: {
        allowWrite: ["/work"],
        denyWrite: ["*.pem"],
      },
    }, cwd);
    expect(result.blocked).toBe(false);
  });

  it("reason string for denyWrite hit contains the load-bearing substring", () => {
    // sandbox.ts branches on this exact substring to decide hard-block vs prompt.
    const result = isWriteBlocked("/work/foo.pem", {
      filesystem: {
        allowWrite: ["/work"],
        denyWrite: ["*.pem"],
      },
    }, cwd);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("matches restricted pattern");
  });
});
