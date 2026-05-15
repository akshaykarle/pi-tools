import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAttemptRow, readAttemptRows, type AttemptRow } from "./attempts-writer.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "attempts-writer-test-"));
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRow(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    attempt: 1,
    task_id: "0001",
    agent: "claude-sonnet-A",
    branch: "task/0001/claude-sonnet-A",
    commit: "abc1234",
    started_at: "2025-07-14T10:00:00Z",
    finished_at: "2025-07-14T10:30:00Z",
    automated: { tests: "pass", types: "pass" },
    rubric: { correctness: 4, quality: 3 },
    score: 3.7,
    status: "accepted",
    judge: "judge-default",
    notes_path: ".worktrees/run-x/output.md",
    ...overrides,
  };
}

// ── appendAttemptRow ──────────────────────────────────────────────────────────

describe("appendAttemptRow", () => {
  it("creates the file when it does not exist", () => {
    const filePath = join(dir, "0001.attempts.jsonl");
    appendAttemptRow(filePath, makeRow());

    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.task_id).toBe("0001");
    expect(parsed.agent).toBe("claude-sonnet-A");
  });

  it("appends to an existing file (append-only)", () => {
    const filePath = join(dir, "0001.attempts.jsonl");

    appendAttemptRow(filePath, makeRow({ attempt: 1, agent: "agent-A", score: 3.7 }));
    appendAttemptRow(filePath, makeRow({ attempt: 2, agent: "agent-B", score: 4.5, status: "champion" }));

    const rows = readAttemptRows(filePath);
    expect(rows).toHaveLength(2);
    expect(rows[0].agent).toBe("agent-A");
    expect(rows[1].agent).toBe("agent-B");
    expect(rows[1].status).toBe("champion");
  });

  it("appending twice produces exactly two rows with no corruption", () => {
    const filePath = join(dir, "0001.attempts.jsonl");

    appendAttemptRow(filePath, makeRow({ attempt: 1, score: 3.0 }));
    appendAttemptRow(filePath, makeRow({ attempt: 2, score: 4.0 }));

    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    // Exactly 2 lines, each parseable as JSON.
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(() => JSON.parse(lines[1])).not.toThrow();
  });

  it("creates parent directories if missing", () => {
    const filePath = join(dir, "nested", "deep", "0001.attempts.jsonl");
    expect(() => appendAttemptRow(filePath, makeRow())).not.toThrow();
    const rows = readAttemptRows(filePath);
    expect(rows).toHaveLength(1);
  });

  it("preserves existing content when appending (no overwrite)", () => {
    const filePath = join(dir, "0001.attempts.jsonl");

    appendAttemptRow(filePath, makeRow({ attempt: 1, score: 3.0 }));
    appendAttemptRow(filePath, makeRow({ attempt: 2, score: 4.5 }));

    const rows = readAttemptRows(filePath);
    expect(rows[0].score).toBe(3.0);
    expect(rows[1].score).toBe(4.5);
    expect(rows[0].attempt).toBe(1);
  });
});

// ── readAttemptRows ───────────────────────────────────────────────────────────

describe("readAttemptRows", () => {
  it("returns empty array when file does not exist", () => {
    expect(readAttemptRows(join(dir, "nonexistent.jsonl"))).toEqual([]);
  });

  it("skips blank lines", () => {
    const filePath = join(dir, "0001.attempts.jsonl");
    appendAttemptRow(filePath, makeRow({ attempt: 1 }));

    // Manually insert a blank line between two rows.
    const existing = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, existing + "\n" + JSON.stringify(makeRow({ attempt: 2 })) + "\n");

    const rows = readAttemptRows(filePath);
    expect(rows).toHaveLength(2);
  });

  it("skips malformed JSON lines without throwing", () => {
    const filePath = join(dir, "0001.attempts.jsonl");
    appendAttemptRow(filePath, makeRow({ attempt: 1 }));
    appendFileSync(filePath, "not-valid-json\n");

    const rows = readAttemptRows(filePath);
    expect(rows).toHaveLength(1);
  });
});
