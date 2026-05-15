// Tests for eval-engine.ts
//
// Strategy: mock execSync so no real shell commands run; assert on observable
// outputs (return values, written file contents) rather than on mock call counts.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock execSync ─────────────────────────────────────────────────────────────
// Hoist the mock so it's available before the module import.
const execSyncMock = vi.hoisted(() => vi.fn(() => ""));
vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

import {
  buildBudgetState,
  buildEvalJson,
  checkBudget,
  computeConfidence,
  runAutomatedChecks,
  writeEvalJson,
  type AutomatedCheckResult,
  type BudgetState,
} from "./eval-engine.js";
import type { AttemptRow } from "./attempts-writer.js";
import type { BacklogSpec, AutomatedCheck } from "./backlog-parser.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCheck(overrides: Partial<AutomatedCheck> = {}): AutomatedCheck {
  return {
    id: "tests-pass",
    cmd: "npm test",
    gate: false,
    ...overrides,
  };
}

function makeRow(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    attempt: 1,
    task_id: "0001",
    agent: "agent-a",
    branch: "task/0001/agent-a",
    commit: "abc1234",
    started_at: "2025-07-14T10:00:00Z",
    finished_at: "2025-07-14T10:30:00Z",
    automated: {},
    rubric: {},
    score: 3.5,
    status: "accepted",
    judge: "judge-default",
    notes_path: "output.md",
    ...overrides,
  };
}

function makeSpec(overrides: Partial<BacklogSpec> = {}): BacklogSpec {
  return {
    id: "0001",
    title: "Test task",
    status: "ready",
    evaluation: {
      mode: "competitive",
      budget: { max_attempts: 3, max_cost_usd: 10 },
      automated: [],
      rubric: [],
      confidence: { enabled: true, min_ratio: 2.0 },
    },
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-engine-test-"));
  execSyncMock.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── runAutomatedChecks ────────────────────────────────────────────────────────

describe("runAutomatedChecks", () => {
  it("returns pass when command exits 0", () => {
    execSyncMock.mockReturnValue("All tests passed\n");
    const checks = [makeCheck({ id: "tests", cmd: "npm test", gate: false })];
    const result = runAutomatedChecks(checks, dir);

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ id: "tests", result: "pass", gated: false });
    expect(result.anyGateFailed).toBe(false);
    expect(result.asMap).toEqual({ tests: "pass" });
  });

  it("returns fail when command throws (non-zero exit)", () => {
    execSyncMock.mockImplementation(() => {
      const err = Object.assign(new Error("exit 1"), { status: 1, stdout: "" });
      throw err;
    });
    const checks = [makeCheck({ id: "tests", cmd: "npm test", gate: false })];
    const result = runAutomatedChecks(checks, dir);

    expect(result.checks[0]).toMatchObject({ id: "tests", result: "fail", gated: false });
    expect(result.anyGateFailed).toBe(false);
  });

  it("sets gated=true and anyGateFailed=true when a gate:true check fails", () => {
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), { status: 1, stdout: "" });
    });
    const checks = [makeCheck({ id: "gate-check", cmd: "npm test", gate: true })];
    const result = runAutomatedChecks(checks, dir);

    expect(result.checks[0].gated).toBe(true);
    expect(result.anyGateFailed).toBe(true);
  });

  it("gate:true check that passes does NOT set anyGateFailed", () => {
    execSyncMock.mockReturnValue("ok");
    const checks = [makeCheck({ id: "gate", cmd: "npm test", gate: true })];
    const result = runAutomatedChecks(checks, dir);

    expect(result.checks[0].gated).toBe(false);
    expect(result.anyGateFailed).toBe(false);
  });

  it("returns numeric AutomatedResult when parse + target match", () => {
    execSyncMock.mockReturnValue("P95_MS=42\n");
    const checks = [
      makeCheck({ id: "latency", cmd: "bench.sh", gate: false, parse: "P95_MS=<num>", target: "<= 50" }),
    ];
    const result = runAutomatedChecks(checks, dir);

    expect(result.checks[0].result).toMatchObject({ value: 42, passed: true });
    expect(result.anyGateFailed).toBe(false);
  });

  it("fails numeric check when value exceeds target", () => {
    execSyncMock.mockReturnValue("P95_MS=99\n");
    const checks = [
      makeCheck({ id: "latency", cmd: "bench.sh", gate: true, parse: "P95_MS=<num>", target: "<= 50" }),
    ];
    const result = runAutomatedChecks(checks, dir);

    expect(result.checks[0].result).toMatchObject({ value: 99, passed: false });
    expect(result.checks[0].gated).toBe(true);
    expect(result.anyGateFailed).toBe(true);
  });

  it("treats as fail when parse pattern is not found in output", () => {
    execSyncMock.mockReturnValue("no matching output\n");
    const checks = [
      makeCheck({ id: "latency", cmd: "bench.sh", gate: true, parse: "P95_MS=<num>", target: "<= 50" }),
    ];
    const result = runAutomatedChecks(checks, dir);

    expect(result.checks[0].result).toBe("fail");
    expect(result.checks[0].gated).toBe(true);
    expect(result.anyGateFailed).toBe(true);
  });

  it("handles multiple checks independently", () => {
    // First passes, second fails.
    execSyncMock
      .mockReturnValueOnce("ok")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("exit 2"), { status: 2, stdout: "" });
      });

    const checks = [
      makeCheck({ id: "lint", cmd: "npm run lint", gate: false }),
      makeCheck({ id: "tests", cmd: "npm test", gate: true }),
    ];
    const result = runAutomatedChecks(checks, dir);

    expect(result.checks[0]).toMatchObject({ id: "lint", result: "pass" });
    expect(result.checks[1]).toMatchObject({ id: "tests", result: "fail", gated: true });
    expect(result.anyGateFailed).toBe(true);
    expect(result.asMap).toEqual({ lint: "pass", tests: "fail" });
  });

  it("returns empty results for empty checks array", () => {
    const result = runAutomatedChecks([], dir);
    expect(result.checks).toHaveLength(0);
    expect(result.anyGateFailed).toBe(false);
    expect(result.asMap).toEqual({});
  });

  it("captures stdout from the error object when command fails", () => {
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), {
        status: 1,
        stdout: "Partial output before failure\n",
      });
    });
    const checks = [makeCheck({ id: "t", cmd: "cmd", gate: false })];
    const result = runAutomatedChecks(checks, dir);
    // The result is "fail" (non-zero exit); no parse — result should be "fail"
    expect(result.checks[0].result).toBe("fail");
  });
});

// ── computeConfidence ─────────────────────────────────────────────────────────

describe("computeConfidence", () => {
  it("returns score=0 and aboveThreshold=false with fewer than 2 scores", () => {
    expect(computeConfidence([], 2.0)).toMatchObject({ score: 0, aboveThreshold: false });
    expect(computeConfidence([4.5], 2.0)).toMatchObject({ score: 0, aboveThreshold: false });
  });

  it("returns method: MAD always", () => {
    const result = computeConfidence([3.0, 4.0], 2.0);
    expect(result.method).toBe("MAD");
  });

  it("returns high confidence when top score is far ahead of second", () => {
    // scores: [5, 1] — gap=4, MAD is deviation from median (3): [2,2] → mad=2, ratio=4/2=2
    const result = computeConfidence([5, 1], 2.0);
    expect(result.score).toBeGreaterThanOrEqual(2.0);
    expect(result.aboveThreshold).toBe(true);
  });

  it("returns low confidence when scores are very close", () => {
    // All identical: gap=0, ratio=0
    const result = computeConfidence([4.0, 4.0, 4.0], 2.0);
    expect(result.score).toBe(0);
    expect(result.aboveThreshold).toBe(false);
  });

  it("handles 3 scores with clear winner", () => {
    // scores: [5, 3, 3] — sorted desc [5,3,3]
    // median = 3, deviations = [0, 0, 2] → sorted [0, 0, 2] → mad = 0
    // gap = 5-3=2, mad=0 → ratio = 999 (Infinity-like)
    const result = computeConfidence([5, 3, 3], 2.0);
    expect(result.aboveThreshold).toBe(true);
  });

  it("uses the provided minRatio in the result", () => {
    const result = computeConfidence([4.5, 3.0], 3.5);
    expect(result.minRatio).toBe(3.5);
  });

  it("correctly handles even-length score arrays for median", () => {
    // [4, 3, 2, 1] sorted desc → median = (3+2)/2 = 2.5
    // deviations [1.5, 0.5, 0.5, 1.5] sorted → [0.5, 0.5, 1.5, 1.5] → mad = (0.5+1.5)/2 = 1
    // gap = 4-3=1, ratio = 1/1 = 1 → below threshold 2.0
    const result = computeConfidence([4, 3, 2, 1], 2.0);
    expect(result.score).toBe(1);
    expect(result.aboveThreshold).toBe(false);
  });

  it("rounds score to 2 decimal places", () => {
    const result = computeConfidence([4.1, 3.9], 2.0);
    const decimals = result.score.toString().split(".")[1];
    expect(decimals === undefined || decimals.length <= 2).toBe(true);
  });
});

// ── buildEvalJson ─────────────────────────────────────────────────────────────

describe("buildEvalJson", () => {
  const budget: BudgetState = {
    attemptsUsed: 2,
    maxAttempts: 3,
    costUsdUsed: 1.5,
    maxCostUsd: 10,
  };

  it("returns no-submissions recommendation when rows is empty", () => {
    const result = buildEvalJson("0001", [], budget);
    expect(result.recommendation).toBe("no submissions yet");
    expect(result.ranking).toHaveLength(0);
    expect(result.attempt_count).toBe(0);
  });

  it("ranks rows descending by score", () => {
    const rows = [
      makeRow({ agent: "agent-b", score: 3.0 }),
      makeRow({ agent: "agent-a", score: 4.5 }),
    ];
    const result = buildEvalJson("0001", rows, budget);
    expect(result.ranking[0].agent).toBe("agent-a");
    expect(result.ranking[0].rank).toBe(1);
    expect(result.ranking[1].agent).toBe("agent-b");
    expect(result.ranking[1].rank).toBe(2);
  });

  it("includes task_id and generated_at", () => {
    const result = buildEvalJson("0005", [], budget);
    expect(result.task_id).toBe("0005");
    expect(result.generated_at).toMatch(/^\d{4}-/); // ISO date prefix
  });

  it("includes budget state in output", () => {
    const result = buildEvalJson("0001", [], budget);
    expect(result.budget.attempts_used).toBe(2);
    expect(result.budget.max_attempts).toBe(3);
    expect(result.budget.cost_usd_used).toBe(1.5);
    expect(result.budget.max_cost_usd).toBe(10);
  });

  it("recommends champion when confidence is above threshold", () => {
    // Two rows with a big score gap → high confidence
    const rows = [
      makeRow({ agent: "a", score: 5 }),
      makeRow({ agent: "b", score: 1 }),
    ];
    const result = buildEvalJson("0001", rows, budget, 2.0);
    expect(result.recommendation).toContain("champion");
  });

  it("recommends rerun when confidence is below threshold", () => {
    // Two rows with identical scores → zero confidence
    const rows = [
      makeRow({ agent: "a", score: 3.5 }),
      makeRow({ agent: "b", score: 3.5 }),
    ];
    const result = buildEvalJson("0001", rows, budget, 2.0);
    expect(result.recommendation).toContain("confidence below threshold");
  });

  it("rounds cost_usd_used to 2 decimal places", () => {
    const b: BudgetState = { attemptsUsed: 1, maxAttempts: 3, costUsdUsed: 1.2345, maxCostUsd: 10 };
    const result = buildEvalJson("0001", [], b);
    // 1.2345 rounded to 2 decimals = 1.23
    expect(result.budget.cost_usd_used).toBe(1.23);
  });
});

// ── writeEvalJson ─────────────────────────────────────────────────────────────

describe("writeEvalJson", () => {
  it("writes the eval JSON to disk atomically", () => {
    const evalPath = join(dir, "0001.eval.json");
    const budget: BudgetState = { attemptsUsed: 1, maxAttempts: 3, costUsdUsed: 0.5, maxCostUsd: 10 };
    const evalJson = buildEvalJson("0001", [], budget);

    writeEvalJson(evalPath, evalJson);

    const written = JSON.parse(readFileSync(evalPath, "utf-8"));
    expect(written.task_id).toBe("0001");
    expect(written.recommendation).toBe("no submissions yet");
  });

  it("creates parent directories if they do not exist", () => {
    const evalPath = join(dir, "deep", "nested", "0001.eval.json");
    const budget: BudgetState = { attemptsUsed: 0, maxAttempts: 3, costUsdUsed: 0, maxCostUsd: 10 };
    const evalJson = buildEvalJson("0001", [], budget);

    expect(() => writeEvalJson(evalPath, evalJson)).not.toThrow();
    expect(JSON.parse(readFileSync(evalPath, "utf-8")).task_id).toBe("0001");
  });

  it("overwrites an existing file atomically (no partial-write window)", () => {
    const evalPath = join(dir, "0001.eval.json");
    const budget: BudgetState = { attemptsUsed: 1, maxAttempts: 3, costUsdUsed: 0, maxCostUsd: 10 };

    writeEvalJson(evalPath, buildEvalJson("0001", [makeRow({ score: 2 })], budget));
    writeEvalJson(evalPath, buildEvalJson("0001", [makeRow({ score: 5 })], budget));

    const written = JSON.parse(readFileSync(evalPath, "utf-8"));
    expect(written.ranking[0].score).toBe(5);
  });
});

// ── checkBudget ───────────────────────────────────────────────────────────────

describe("checkBudget", () => {
  it("returns halted:false when both caps are clear", () => {
    const rows = [makeRow()];
    const spec = makeSpec({ evaluation: { mode: "competitive", budget: { max_attempts: 3, max_cost_usd: 10 }, automated: [], rubric: [] } });
    expect(checkBudget(rows, spec)).toEqual({ halted: false });
  });

  it("halts when attempt count reaches max_attempts", () => {
    const rows = [makeRow({ attempt: 1 }), makeRow({ attempt: 2 }), makeRow({ attempt: 3 })];
    const spec = makeSpec({ evaluation: { mode: "competitive", budget: { max_attempts: 3, max_cost_usd: 100 }, automated: [], rubric: [] } });
    const result = checkBudget(rows, spec);
    expect(result.halted).toBe(true);
    expect(result.reason).toContain("max_attempts");
  });

  it("halts when cost reaches max_cost_usd", () => {
    const rows = [makeRow({ cost_usd: 5.5 }), makeRow({ cost_usd: 6.0 })];
    const spec = makeSpec({ evaluation: { mode: "competitive", budget: { max_attempts: 100, max_cost_usd: 10 }, automated: [], rubric: [] } });
    const result = checkBudget(rows, spec);
    expect(result.halted).toBe(true);
    expect(result.reason).toContain("max_cost_usd");
  });

  it("uses defaults (max_attempts:3, max_cost_usd:50) when budget is absent", () => {
    const rows: AttemptRow[] = [];
    const spec: BacklogSpec = { id: "0001", title: "x", status: "ready" };
    expect(checkBudget(rows, spec)).toEqual({ halted: false });
  });

  it("does not halt if costs are just below cap", () => {
    const rows = [makeRow({ cost_usd: 9.99 })];
    const spec = makeSpec({ evaluation: { mode: "competitive", budget: { max_attempts: 5, max_cost_usd: 10 }, automated: [], rubric: [] } });
    expect(checkBudget(rows, spec)).toEqual({ halted: false });
  });

  it("halts on attempts-exceeded when attempts exactly equal max", () => {
    const rows = [makeRow()]; // 1 row
    const spec = makeSpec({ evaluation: { mode: "competitive", budget: { max_attempts: 1, max_cost_usd: 100 }, automated: [], rubric: [] } });
    const result = checkBudget(rows, spec);
    expect(result.halted).toBe(true);
  });
});

// ── buildBudgetState ──────────────────────────────────────────────────────────

describe("buildBudgetState", () => {
  it("returns correct used counts from rows", () => {
    const rows = [makeRow({ cost_usd: 1.0 }), makeRow({ cost_usd: 2.5 })];
    const spec = makeSpec();
    const state = buildBudgetState(rows, spec);

    expect(state.attemptsUsed).toBe(2);
    expect(state.costUsdUsed).toBe(3.5);
  });

  it("returns spec's max_attempts and max_cost_usd", () => {
    const rows: AttemptRow[] = [];
    const spec = makeSpec({ evaluation: { mode: "competitive", budget: { max_attempts: 5, max_cost_usd: 20 }, automated: [], rubric: [] } });
    const state = buildBudgetState(rows, spec);

    expect(state.maxAttempts).toBe(5);
    expect(state.maxCostUsd).toBe(20);
  });

  it("uses defaults when budget is absent from spec", () => {
    const spec: BacklogSpec = { id: "0001", title: "x", status: "ready" };
    const state = buildBudgetState([], spec);
    expect(state.maxAttempts).toBe(3);
    expect(state.maxCostUsd).toBe(50);
  });

  it("handles rows with no cost_usd (treats as 0)", () => {
    const rows = [makeRow()]; // no cost_usd
    const spec = makeSpec();
    const state = buildBudgetState(rows, spec);
    expect(state.costUsdUsed).toBe(0);
  });
});
