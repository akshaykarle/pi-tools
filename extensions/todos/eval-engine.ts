// Eval engine — orchestration logic for evaluate/rank/finalize actions.
//
// Commands from evaluation.automated are treated as trusted (authored by repo
// maintainers, same as CI scripts). They are executed via execSync in the
// candidate's worktree directory.

import { execSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { BacklogSpec, AutomatedCheck } from "./backlog-parser.js";
import type { AttemptRow, AutomatedResult } from "./attempts-writer.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutomatedCheckResult {
  id: string;
  result: "pass" | "fail" | AutomatedResult;
  /** True when this check is a gate and it failed. */
  gated: boolean;
}

export interface AutomatedResults {
  checks: AutomatedCheckResult[];
  /** True when any gate:true check failed. */
  anyGateFailed: boolean;
  /** Compact map suitable for the AttemptRow.automated field. */
  asMap: Record<string, "pass" | "fail" | AutomatedResult>;
}

export interface ConfidenceResult {
  score: number;
  aboveThreshold: boolean;
  minRatio: number;
  method: "MAD";
}

export interface BudgetState {
  attemptsUsed: number;
  maxAttempts: number | null;
  costUsdUsed: number;
  maxCostUsd: number | null;
}

export interface BudgetCheckResult {
  halted: boolean;
  reason?: string;
}

export interface EvalRankingEntry {
  rank: number;
  agent: string;
  score: number;
  status: AttemptRow["status"];
  branch: string;
}

export interface EvalJson {
  task_id: string;
  generated_at: string;
  attempt_count: number;
  budget: {
    attempts_used: number;
    max_attempts: number | null;
    cost_usd_used: number;
    max_cost_usd: number | null;
  };
  confidence: ConfidenceResult;
  ranking: EvalRankingEntry[];
  recommendation: string;
}

// ── Automated checks ──────────────────────────────────────────────────────────

/**
 * Parse a numeric value from stdout using the VARNAME=<num> pattern.
 * Returns null if the pattern is not found.
 */
function parseNumericOutput(stdout: string, parsePattern: string): number | null {
  // Extract variable name from pattern like "P95_MS=<num>" → "P95_MS"
  const varName = parsePattern.replace(/=.*$/, "").trim();
  const regex = new RegExp(`${varName}=(\\d+(?:\\.\\d+)?)`);
  const match = stdout.match(regex);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Evaluate a comparison expression like "<= 50" or ">= 500" against a number.
 * Returns true if the value satisfies the expression.
 */
function evaluateTarget(value: number, target: string): boolean {
  const match = target.trim().match(/^([<>]=?)\s*(\d+(?:\.\d+)?)$/);
  if (!match) {
    console.warn(`[eval-engine] invalid target expression: "${target}"`);
    return false;
  }
  const [, op, rhs] = match;
  const rhsNum = parseFloat(rhs);
  switch (op) {
    case "<":  return value < rhsNum;
    case "<=": return value <= rhsNum;
    case ">":  return value > rhsNum;
    case ">=": return value >= rhsNum;
    default:   return false;
  }
}

/**
 * Run all evaluation.automated commands from the spec in the given worktree.
 * Returns structured results including a gate-failure flag.
 */
export function runAutomatedChecks(
  checks: AutomatedCheck[],
  worktreePath: string,
): AutomatedResults {
  const results: AutomatedCheckResult[] = [];
  let anyGateFailed = false;

  for (const check of checks) {
    let stdout = "";
    let exitCode = 0;

    try {
      stdout = execSync(check.cmd, {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      exitCode = (err as { status?: number }).status ?? 1;
      stdout = (err as { stdout?: string }).stdout ?? "";
    }

    const passed = exitCode === 0;

    let result: "pass" | "fail" | AutomatedResult;
    if (check.parse && check.target) {
      const value = parseNumericOutput(stdout, check.parse);
      if (value !== null) {
        const numPassed = evaluateTarget(value, check.target);
        result = { value, passed: numPassed };
        if (check.gate && !numPassed) anyGateFailed = true;
      } else {
        // Pattern not found in output — treat as fail.
        result = "fail";
        if (check.gate) anyGateFailed = true;
      }
    } else {
      result = passed ? "pass" : "fail";
      if (check.gate && !passed) anyGateFailed = true;
    }

    results.push({
      id: check.id,
      result,
      gated: check.gate === true && (result === "fail" || (typeof result === "object" && !result.passed)),
    });
  }

  const asMap: Record<string, "pass" | "fail" | AutomatedResult> = {};
  for (const r of results) {
    asMap[r.id] = r.result;
  }

  return { checks: results, anyGateFailed, asMap };
}

// ── Confidence (MAD) ──────────────────────────────────────────────────────────

/**
 * Compute confidence score using Median Absolute Deviation.
 *
 * With fewer than 2 scores, confidence is 0 (cannot compare).
 * Algorithm:
 *   1. Sort scores descending.
 *   2. Compute median.
 *   3. MAD = median of |score − median| for all scores.
 *   4. gap = rank1 − rank2 (top two scores).
 *   5. ratio = MAD > 0 ? gap / MAD : (gap > 0 ? Infinity : 0).
 */
export function computeConfidence(scores: number[], minRatio: number): ConfidenceResult {
  if (scores.length < 2) {
    return { score: 0, aboveThreshold: false, minRatio, method: "MAD" };
  }

  const sorted = [...scores].sort((a, b) => b - a);

  // Median of all scores.
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  // MAD.
  const deviations = sorted.map((s) => Math.abs(s - median)).sort((a, b) => a - b);
  const madMid = Math.floor(deviations.length / 2);
  const mad =
    deviations.length % 2 === 0
      ? (deviations[madMid - 1] + deviations[madMid]) / 2
      : deviations[madMid];

  const gap = sorted[0] - sorted[1];
  const ratio = mad > 0 ? gap / mad : gap > 0 ? 999 : 0;

  return {
    score: Math.round(ratio * 100) / 100,
    aboveThreshold: ratio >= minRatio,
    minRatio,
    method: "MAD",
  };
}

// ── Eval JSON assembly ────────────────────────────────────────────────────────

/**
 * Build the *.eval.json object from the current set of attempt rows.
 * Rows are ranked by score descending; champions are labelled in place.
 */
export function buildEvalJson(
  taskId: string,
  rows: AttemptRow[],
  budget: BudgetState,
  minRatio: number = 2.0,
): EvalJson {
  // Sort descending by score.
  const sorted = [...rows].sort((a, b) => b.score - a.score);

  const scores = sorted.map((r) => r.score);
  const confidence = computeConfidence(scores, minRatio);

  const ranking: EvalRankingEntry[] = sorted.map((r, i) => ({
    rank: i + 1,
    agent: r.agent,
    score: r.score,
    status: r.status,
    branch: r.branch,
  }));

  let recommendation: string;
  if (sorted.length === 0) {
    recommendation = "no submissions yet";
  } else if (confidence.aboveThreshold) {
    recommendation = "champion identified — ready for task-finalize";
  } else {
    recommendation = "confidence below threshold — rerun recommended";
  }

  return {
    task_id: taskId,
    generated_at: new Date().toISOString(),
    attempt_count: rows.length,
    budget: {
      attempts_used: budget.attemptsUsed,
      max_attempts: budget.maxAttempts,
      cost_usd_used: Math.round(budget.costUsdUsed * 100) / 100,
      max_cost_usd: budget.maxCostUsd,
    },
    confidence,
    ranking,
    recommendation,
  };
}

/**
 * Atomically write *.eval.json to disk.
 */
export function writeEvalJson(filePath: string, evalJson: EvalJson): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, JSON.stringify(evalJson, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

// ── Budget check ──────────────────────────────────────────────────────────────

/**
 * Check whether a budget cap has been reached before dispatching a new round.
 *
 * Returns { halted: false } if both caps are clear (or null/disabled).
 * Returns { halted: true, reason } if either cap is hit.
 */
export function checkBudget(rows: AttemptRow[], spec: BacklogSpec): BudgetCheckResult {
  const budget = spec.evaluation?.budget;
  const maxAttempts = budget?.max_attempts ?? 3;
  const maxCostUsd = budget?.max_cost_usd ?? 50;

  const attemptCount = rows.length;
  const totalCost = rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);

  if (maxAttempts !== null && attemptCount >= maxAttempts) {
    return {
      halted: true,
      reason: `max_attempts reached (${attemptCount}/${maxAttempts})`,
    };
  }

  if (maxCostUsd !== null && totalCost >= maxCostUsd) {
    return {
      halted: true,
      reason: `max_cost_usd reached ($${totalCost.toFixed(2)}/$${maxCostUsd})`,
    };
  }

  return { halted: false };
}

/**
 * Build a BudgetState summary from the current rows + spec caps.
 * Used when assembling eval.json.
 */
export function buildBudgetState(rows: AttemptRow[], spec: BacklogSpec): BudgetState {
  const budget = spec.evaluation?.budget;
  return {
    attemptsUsed: rows.length,
    maxAttempts: budget?.max_attempts ?? 3,
    costUsdUsed: rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0),
    maxCostUsd: budget?.max_cost_usd ?? 50,
  };
}
