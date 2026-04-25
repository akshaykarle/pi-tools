import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addDomainToConfig,
  addWritePathToConfig,
  createSessionState,
} from "./session-state.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ss-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createSessionState", () => {
  it("returns a fresh, empty state", () => {
    const s = createSessionState();
    expect(s).toEqual({ domains: [], writePaths: [] });
  });

  it("produces isolated instances across calls", () => {
    const a = createSessionState();
    const b = createSessionState();
    a.domains.push("x.com");
    expect(b.domains).toEqual([]);
  });
});

describe("addDomainToConfig", () => {
  it("creates a new file with the domain when file does not exist", () => {
    const path = join(tmp, "sandbox.json");
    addDomainToConfig(path, "new.com");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.network.allowedDomains).toEqual(["new.com"]);
  });

  it("preserves unrelated sections (filesystem) when adding to network", () => {
    const path = join(tmp, "sandbox.json");
    writeFileSync(
      path,
      JSON.stringify({
        filesystem: { allowWrite: ["/work"] },
        somethingElse: "keep me",
      }),
    );
    addDomainToConfig(path, "new.com");
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.filesystem).toEqual({ allowWrite: ["/work"] });
    expect(parsed.somethingElse).toBe("keep me");
    expect(parsed.network.allowedDomains).toEqual(["new.com"]);
  });

  it("is idempotent for a duplicate domain (no rewrite)", () => {
    const path = join(tmp, "sandbox.json");
    addDomainToConfig(path, "same.com");
    const mtime1 = statSync(path).mtimeMs;
    const content1 = readFileSync(path, "utf-8");
    // Delay briefly to make mtime comparison meaningful.
    addDomainToConfig(path, "same.com");
    const content2 = readFileSync(path, "utf-8");
    expect(content2).toBe(content1);
    const mtime2 = statSync(path).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it("creates non-existent parent dirs recursively", () => {
    const path = join(tmp, "nested", "deeper", "sandbox.json");
    addDomainToConfig(path, "x.com");
    expect(existsSync(path)).toBe(true);
  });
});

describe("addWritePathToConfig", () => {
  it("creates a new file with the path when file does not exist", () => {
    const path = join(tmp, "sandbox.json");
    addWritePathToConfig(path, "/extra/write");
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.filesystem.allowWrite).toEqual(["/extra/write"]);
  });

  it("preserves unrelated sections (network) when adding to filesystem", () => {
    const path = join(tmp, "sandbox.json");
    writeFileSync(
      path,
      JSON.stringify({
        network: { allowedDomains: ["a.com"] },
      }),
    );
    addWritePathToConfig(path, "/extra/write");
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.network).toEqual({ allowedDomains: ["a.com"] });
    expect(parsed.filesystem.allowWrite).toEqual(["/extra/write"]);
  });

  it("is idempotent for a duplicate path", () => {
    const path = join(tmp, "sandbox.json");
    addWritePathToConfig(path, "/w");
    const content1 = readFileSync(path, "utf-8");
    addWritePathToConfig(path, "/w");
    const content2 = readFileSync(path, "utf-8");
    expect(content2).toBe(content1);
  });

  it("creates non-existent parent dirs recursively", () => {
    const path = join(tmp, "a", "b", "c", "sandbox.json");
    addWritePathToConfig(path, "/w");
    expect(existsSync(path)).toBe(true);
  });
});
