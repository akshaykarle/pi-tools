// Attempts writer — append-only atomic writer for *.attempts.jsonl files.
//
// SINGLE WRITER ASSUMPTION: this module assumes only one process appends to a
// given *.attempts.jsonl file at a time. The atomic rename pattern (write to a
// temp file, then rename) prevents torn reads but does not provide mutual
// exclusion across concurrent processes. If two processes call appendAttemptRow
// simultaneously, the second rename will silently overwrite the first appended
// line. This is acceptable for the current use-case (orchestrator is the sole
// writer in a single-process session).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

// ── AttemptRow schema ─────────────────────────────────────────────────────────
// Matches the *.attempts.jsonl row format documented in docs/agent-task-spec.md
// §"The attempts log".

export interface AutomatedResult {
  value: number;
  passed: boolean;
}

export interface AttemptRow {
  /** Monotonically increasing attempt number within this task (1-based). */
  attempt: number;
  /** Spec id (zero-padded string, e.g. "0001"). */
  task_id: string;
  /** Agent name. */
  agent: string;
  /** Git branch name for this submission. */
  branch: string;
  /** 7-char git commit sha. */
  commit: string;
  /** ISO timestamp when the agent started. */
  started_at: string;
  /** ISO timestamp when the agent finished. */
  finished_at: string;
  /**
   * Automated check results keyed by check id.
   * Value is "pass" | "fail" for boolean checks, or AutomatedResult for numeric.
   */
  automated: Record<string, "pass" | "fail" | AutomatedResult>;
  /**
   * Rubric scores keyed by criterion id (1–5 scale).
   * When AC fallback is used, key is "ac_satisfaction".
   */
  rubric: Record<string, number>;
  /** Weighted composite score (0–5). */
  score: number;
  /** Submission status after evaluation. */
  status: "champion" | "accepted" | "rejected" | "gated";
  /** Name of the judge agent that produced the scores. */
  judge: string;
  /** Relative path to the judge's notes / output.md. */
  notes_path: string;
  /** Token cost for this attempt in USD (optional — omit if unknown). */
  cost_usd?: number;
}

// ── Append ────────────────────────────────────────────────────────────────────

/**
 * Append one row to a *.attempts.jsonl file.
 *
 * The write is atomic: data is written to a temp file first, then renamed over
 * the target path. The temp file sits in the same directory as the target so
 * the rename is a same-filesystem move (instant, no partial-write window).
 */
export function appendAttemptRow(filePath: string, row: AttemptRow): void {
  mkdirSync(dirname(filePath), { recursive: true });

  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  // Ensure existing content ends with a newline before appending.
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? existing + "\n" : existing;
  const newContent = prefix + JSON.stringify(row) + "\n";

  const tmpPath = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, newContent, "utf-8");
  renameSync(tmpPath, filePath);
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Read all rows from a *.attempts.jsonl file.
 * Skips blank lines and malformed JSON with a warning (never throws).
 * Returns an empty array if the file does not exist.
 */
export function readAttemptRows(filePath: string): AttemptRow[] {
  if (!existsSync(filePath)) return [];

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.warn(`[attempts-writer] ${filePath}: read error — ${String(err)}`);
    return [];
  }

  const rows: AttemptRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as AttemptRow);
    } catch {
      console.warn(`[attempts-writer] ${filePath}: skipping malformed line: ${trimmed.slice(0, 80)}`);
    }
  }
  return rows;
}
