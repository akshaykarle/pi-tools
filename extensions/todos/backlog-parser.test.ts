import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapStatusToTaskStatus, normaliseSpecId, parseSpecFile } from "./backlog-parser.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backlog-parser-test-"));
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSpec(filename: string, content: string): string {
  const p = join(dir, filename);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ── parseSpecFile ─────────────────────────────────────────────────────────────

describe("parseSpecFile", () => {
  it("parses a minimal valid spec", () => {
    const p = writeSpec("0001-test.md", `---
id: 1
title: "Test task"
status: ready
---

## Why
Because.
`);
    const spec = parseSpecFile(p);
    expect(spec).not.toBeNull();
    expect(spec!.id).toBe(1);
    expect(spec!.title).toBe("Test task");
    expect(spec!.status).toBe("ready");
  });

  it("parses a full spec with evaluation block", () => {
    const p = writeSpec("0002-full.md", `---
id: 2
title: "Full spec"
status: draft
priority: P1
effort: M
created: "2025-07-14"
owner: "alice"
assignees: []
depends_on: [1]
tags: [tooling]
evaluation:
  mode: competitive
  workspace: worktree
  budget:
    max_attempts: 3
    max_cost_usd: 50
  automated:
    - id: tests
      cmd: "npm test"
      gate: true
  rubric:
    - id: correctness
      weight: 0.6
    - id: quality
      weight: 0.4
  scoring:
    automated_weight: 0.6
    rubric_weight: 0.4
  judge: judge-default
  confidence:
    enabled: true
    min_ratio: 2.0
---
`);
    const spec = parseSpecFile(p);
    expect(spec).not.toBeNull();
    expect(spec!.evaluation?.mode).toBe("competitive");
    expect(spec!.evaluation?.automated).toHaveLength(1);
    expect(spec!.evaluation?.automated![0].gate).toBe(true);
    expect(spec!.evaluation?.rubric).toHaveLength(2);
    expect(spec!.evaluation?.budget?.max_attempts).toBe(3);
    expect(spec!.tags).toEqual(["tooling"]);
  });

  it("returns null for a missing file", () => {
    const result = parseSpecFile(join(dir, "nonexistent.md"));
    expect(result).toBeNull();
  });

  it("returns null when frontmatter is absent", () => {
    const p = writeSpec("no-fm.md", "# No frontmatter\n\nJust prose.\n");
    expect(parseSpecFile(p)).toBeNull();
  });

  it("returns null for invalid YAML", () => {
    const p = writeSpec("bad-yaml.md", "---\nid: : invalid\n---\n");
    expect(parseSpecFile(p)).toBeNull();
  });

  it("returns null when 'id' is missing", () => {
    const p = writeSpec("no-id.md", "---\ntitle: Missing ID\nstatus: draft\n---\n");
    expect(parseSpecFile(p)).toBeNull();
  });

  it("returns null when 'title' is missing", () => {
    const p = writeSpec("no-title.md", "---\nid: 3\nstatus: draft\n---\n");
    expect(parseSpecFile(p)).toBeNull();
  });

  it("returns null for an invalid status value", () => {
    const p = writeSpec("bad-status.md", "---\nid: 4\ntitle: Bad\nstatus: pending\n---\n");
    expect(parseSpecFile(p)).toBeNull();
  });

  it("accepts spec files that start with an HTML comment (TEMPLATE.md pattern)", () => {
    const p = writeSpec("template.md", `<!-- This is a template -->
---
id: NNNN
title: "Placeholder"
status: draft
---
`);
    const spec = parseSpecFile(p);
    expect(spec).not.toBeNull();
    expect(spec!.status).toBe("draft");
  });

  it("allows null budget caps", () => {
    const p = writeSpec("null-caps.md", `---
id: 5
title: "Unlimited"
status: ready
evaluation:
  budget:
    max_attempts: null
    max_cost_usd: null
---
`);
    const spec = parseSpecFile(p);
    expect(spec).not.toBeNull();
    expect(spec!.evaluation?.budget?.max_attempts).toBeNull();
    expect(spec!.evaluation?.budget?.max_cost_usd).toBeNull();
  });
});

// ── mapStatusToTaskStatus ─────────────────────────────────────────────────────

describe("mapStatusToTaskStatus", () => {
  it("maps draft → queued", () => expect(mapStatusToTaskStatus("draft")).toBe("queued"));
  it("maps ready → queued", () => expect(mapStatusToTaskStatus("ready")).toBe("queued"));
  it("maps in-progress → in-progress", () =>
    expect(mapStatusToTaskStatus("in-progress")).toBe("in-progress"));
  it("maps in-review → in-progress", () =>
    expect(mapStatusToTaskStatus("in-review")).toBe("in-progress"));
  it("maps done → done", () => expect(mapStatusToTaskStatus("done")).toBe("done"));
  it("maps cancelled → failed", () =>
    expect(mapStatusToTaskStatus("cancelled")).toBe("failed"));
});

// ── normaliseSpecId ───────────────────────────────────────────────────────────

describe("normaliseSpecId", () => {
  it("zero-pads a number", () => expect(normaliseSpecId(1)).toBe("0001"));
  it("leaves a 4-digit number unchanged", () => expect(normaliseSpecId(1234)).toBe("1234"));
  it("handles a string id", () => expect(normaliseSpecId("42")).toBe("0042"));
  it("handles already-padded string", () => expect(normaliseSpecId("0001")).toBe("0001"));
});
