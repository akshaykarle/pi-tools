import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configPaths,
  DEFAULT_CONFIG,
  DEFAULT_STRIP_VARS,
  effectiveStripList,
  loadConfig,
  sectionReplaceMerge,
  type SandboxConfig,
} from "./config.js";

// Tests stub PI_CODING_AGENT_DIR via vi.stubEnv and stub getAgentDir via vi.mock.
// getAgentDir is imported by config.ts from @mariozechner/pi-coding-agent,
// so we mock it at the module level.

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => process.env.__TEST_AGENT_DIR__ ?? "/tmp/test-agent-dir",
}));

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "config-"));
  process.env.__TEST_AGENT_DIR__ = tmp;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.__TEST_AGENT_DIR__;
  vi.unstubAllEnvs();
});

function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj));
}

describe("configPaths — profile resolution", () => {
  it("derives project path from PI_CODING_AGENT_DIR basename", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/home/x/.pi-sahaj");
    const { projectPath } = configPaths("/work");
    expect(projectPath).toBe("/work/.pi-sahaj/sandbox.json");
  });

  it("falls back to .pi when PI_CODING_AGENT_DIR is unset", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    const { projectPath } = configPaths("/work");
    expect(projectPath).toBe("/work/.pi/sandbox.json");
  });

  it("uses basename for non-standard PI_CODING_AGENT_DIR values", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/weird/path");
    const { projectPath } = configPaths("/work");
    expect(projectPath).toBe("/work/path/sandbox.json");
  });

  it("userPath is getAgentDir() + /sandbox.json", () => {
    const { userPath } = configPaths("/work");
    expect(userPath).toBe(`${tmp}/sandbox.json`);
  });
});

describe("sectionReplaceMerge — section-level replace (decision 4b)", () => {
  const base: SandboxConfig = {
    enabled: true,
    network: { allowedDomains: ["a.com"], deniedDomains: [] },
    filesystem: { denyRead: ["/x"], allowWrite: ["/w"], denyWrite: [] },
    env: { strip: ["A", "B"] },
  };

  it("override with only network replaces base.network wholesale", () => {
    const merged = sectionReplaceMerge(base, {
      network: { allowedDomains: ["b.com"], deniedDomains: [] },
    });
    expect(merged.network?.allowedDomains).toEqual(["b.com"]);
    expect(merged.filesystem).toEqual(base.filesystem);
  });

  it("network.allowedDomains from override fully replaces (NOT concatenated)", () => {
    const merged = sectionReplaceMerge(base, {
      network: { allowedDomains: ["b.com"], deniedDomains: [] },
    });
    expect(merged.network?.allowedDomains).toEqual(["b.com"]);
    expect(merged.network?.allowedDomains).not.toContain("a.com");
  });

  it("base network + override filesystem = merged network + filesystem", () => {
    const merged = sectionReplaceMerge(base, {
      filesystem: { denyRead: ["/y"], allowWrite: ["/w2"], denyWrite: [] },
    });
    expect(merged.network).toEqual(base.network);
    expect(merged.filesystem?.denyRead).toEqual(["/y"]);
    expect(merged.filesystem?.allowWrite).toEqual(["/w2"]);
  });

  it("override enabled:false replaces default enabled:true", () => {
    const merged = sectionReplaceMerge(base, { enabled: false });
    expect(merged.enabled).toBe(false);
  });
});

describe("env.strip — union-only across layers", () => {
  const base: SandboxConfig = { env: { strip: ["A", "B"] } };

  it("union extends the base list", () => {
    const merged = sectionReplaceMerge(base, { env: { strip: ["C"] } });
    expect(new Set(merged.env?.strip)).toEqual(new Set(["A", "B", "C"]));
  });

  it("union dedupes when override repeats existing values", () => {
    const merged = sectionReplaceMerge(base, { env: { strip: ["A", "C"] } });
    expect(new Set(merged.env?.strip)).toEqual(new Set(["A", "B", "C"]));
    expect(merged.env?.strip?.length).toBe(3);
  });

  it("project layer (subset of defaults) CANNOT shrink the list", () => {
    // In practice, effectiveStripList always re-unions with DEFAULT_STRIP_VARS,
    // but sectionReplaceMerge on its own is also extend-only per the env exception.
    const merged = sectionReplaceMerge(base, { env: { strip: ["A"] } });
    expect(new Set(merged.env?.strip)).toEqual(new Set(["A", "B"]));
  });

  it("override with env but no strip leaves base strip intact", () => {
    const merged = sectionReplaceMerge(base, { env: {} });
    expect(merged.env?.strip).toEqual(["A", "B"]);
  });
});

describe("effectiveStripList — always includes DEFAULT_STRIP_VARS", () => {
  it("returns defaults when config has no env section", () => {
    const list = effectiveStripList({});
    expect(new Set(list)).toEqual(new Set(DEFAULT_STRIP_VARS));
  });

  it("unions defaults with config.env.strip", () => {
    const list = effectiveStripList({ env: { strip: ["CUSTOM_SECRET"] } });
    expect(list).toContain("CUSTOM_SECRET");
    for (const v of DEFAULT_STRIP_VARS) {
      expect(list).toContain(v);
    }
  });

  it("dedupes when config.env.strip overlaps defaults", () => {
    const list = effectiveStripList({ env: { strip: ["ANTHROPIC_API_KEY"] } });
    const count = list.filter((v) => v === "ANTHROPIC_API_KEY").length;
    expect(count).toBe(1);
  });
});

describe("loadConfig — layered merge behaviour", () => {
  it("returns DEFAULT_CONFIG when neither file exists", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/fake/.pi-test");
    const loaded = loadConfig(tmp);
    expect(loaded.network?.allowedDomains).toEqual(DEFAULT_CONFIG.network!.allowedDomains);
  });

  it("user layer overrides DEFAULT for the sections it sets", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/fake/.pi-test");
    writeJson(join(tmp, "sandbox.json"), {
      network: { allowedDomains: ["user-only.com"], deniedDomains: [] },
    });
    const loaded = loadConfig(tmp);
    expect(loaded.network?.allowedDomains).toEqual(["user-only.com"]);
    // filesystem not touched by user → still default
    expect(loaded.filesystem?.denyRead).toEqual(DEFAULT_CONFIG.filesystem!.denyRead);
  });

  it("project layer overrides user layer", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/fake/.pi-test");
    writeJson(join(tmp, "sandbox.json"), {
      network: { allowedDomains: ["user-only.com"], deniedDomains: [] },
    });
    mkdirSync(join(tmp, ".pi-test"));
    writeJson(join(tmp, ".pi-test", "sandbox.json"), {
      network: { allowedDomains: ["project-only.com"], deniedDomains: [] },
    });
    const loaded = loadConfig(tmp);
    expect(loaded.network?.allowedDomains).toEqual(["project-only.com"]);
  });

  it("invalid JSON at a layer is skipped with stderr warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("PI_CODING_AGENT_DIR", "/fake/.pi-test");
    writeFileSync(join(tmp, "sandbox.json"), "{ broken");
    const loaded = loadConfig(tmp);
    expect(spy).toHaveBeenCalled();
    // Defaults still applied
    expect(loaded.filesystem?.denyRead).toEqual(DEFAULT_CONFIG.filesystem!.denyRead);
    spy.mockRestore();
  });

  it("invalid JSON at project layer does not swallow user layer", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("PI_CODING_AGENT_DIR", "/fake/.pi-test");
    writeJson(join(tmp, "sandbox.json"), {
      network: { allowedDomains: ["user.com"], deniedDomains: [] },
    });
    mkdirSync(join(tmp, ".pi-test"));
    writeFileSync(join(tmp, ".pi-test", "sandbox.json"), "not json");
    const loaded = loadConfig(tmp);
    expect(loaded.network?.allowedDomains).toEqual(["user.com"]);
    spy.mockRestore();
  });

  it("env.strip unions across all three layers", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/fake/.pi-test");
    writeJson(join(tmp, "sandbox.json"), { env: { strip: ["USER_SECRET"] } });
    mkdirSync(join(tmp, ".pi-test"));
    writeJson(join(tmp, ".pi-test", "sandbox.json"), {
      env: { strip: ["PROJECT_SECRET"] },
    });
    const loaded = loadConfig(tmp);
    const effective = new Set(effectiveStripList(loaded));
    expect(effective.has("USER_SECRET")).toBe(true);
    expect(effective.has("PROJECT_SECRET")).toBe(true);
    for (const v of DEFAULT_STRIP_VARS) {
      expect(effective.has(v)).toBe(true);
    }
  });
});

describe("DEFAULT_CONFIG shape guard", () => {
  it("all allowedDomains are lowercase", () => {
    for (const d of DEFAULT_CONFIG.network!.allowedDomains) {
      expect(d).toBe(d.toLowerCase());
    }
  });

  it("no duplicates in any allowlist or denylist", () => {
    const lists: string[][] = [
      DEFAULT_CONFIG.network!.allowedDomains,
      DEFAULT_CONFIG.network!.deniedDomains,
      DEFAULT_CONFIG.filesystem!.denyRead,
      DEFAULT_CONFIG.filesystem!.allowWrite,
      DEFAULT_CONFIG.filesystem!.denyWrite,
      DEFAULT_CONFIG.env!.strip!,
    ];
    for (const list of lists) {
      expect(list.length).toBe(new Set(list).size);
    }
  });

  it("includes critical provider domains", () => {
    const allowed = new Set(DEFAULT_CONFIG.network!.allowedDomains);
    expect(allowed.has("api.anthropic.com")).toBe(true);
    expect(allowed.has("api.openai.com")).toBe(true);
  });

  it("includes sensitive home paths in denyRead", () => {
    const denyRead = new Set(DEFAULT_CONFIG.filesystem!.denyRead);
    for (const p of ["~/.ssh", "~/.aws", "~/.gnupg", "~/.npmrc", "~/.netrc"]) {
      expect(denyRead.has(p)).toBe(true);
    }
  });

  it("includes secret-file patterns in denyWrite", () => {
    const denyWrite = new Set(DEFAULT_CONFIG.filesystem!.denyWrite);
    for (const p of [".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_ed25519"]) {
      expect(denyWrite.has(p)).toBe(true);
    }
  });

  it("frozen snapshot — alert on accidental edits", () => {
    // If this fails, review DEFAULT_CONFIG carefully and update the snapshot deliberately.
    expect(DEFAULT_CONFIG).toMatchSnapshot();
  });
});
