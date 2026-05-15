// Backlog spec parser — reads NNNN-slug.md files from PI_BACKLOG_DIR.
//
// Parses the YAML frontmatter block (delimited by ---), validates it against a
// typebox schema, and returns a typed BacklogSpec object. Invalid files are
// logged and return null — they never crash import_backlog for the whole directory.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { Type, type Static } from "typebox";
import type { TaskStatus } from "./task-board.js";

// ── Typebox schema ────────────────────────────────────────────────────────────

const AutomatedCheckSchema = Type.Object({
  id: Type.String(),
  cmd: Type.String(),
  gate: Type.Optional(Type.Boolean()),
  parse: Type.Optional(Type.String()),
  target: Type.Optional(Type.String()),
});

const RubricCriterionSchema = Type.Object({
  id: Type.String(),
  weight: Type.Number(),
});

const EvaluationSchema = Type.Optional(
  Type.Object({
    mode: Type.Optional(
      Type.Union([Type.Literal("solo"), Type.Literal("coordinated"), Type.Literal("competitive")]),
    ),
    workspace: Type.Optional(Type.String()),
    budget: Type.Optional(
      Type.Object({
        max_attempts: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        max_cost_usd: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      }),
    ),
    automated: Type.Optional(Type.Array(AutomatedCheckSchema)),
    rubric: Type.Optional(Type.Array(RubricCriterionSchema)),
    scoring: Type.Optional(
      Type.Object({
        automated_weight: Type.Optional(Type.Number()),
        rubric_weight: Type.Optional(Type.Number()),
      }),
    ),
    judge: Type.Optional(Type.String()),
    confidence: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        min_ratio: Type.Optional(Type.Number()),
      }),
    ),
  }),
);

export const BacklogSpecSchema = Type.Object({
  id: Type.Union([Type.Number(), Type.String()]),
  title: Type.String(),
  status: Type.Union([
    Type.Literal("draft"),
    Type.Literal("ready"),
    Type.Literal("in-progress"),
    Type.Literal("in-review"),
    Type.Literal("done"),
    Type.Literal("cancelled"),
  ]),
  priority: Type.Optional(
    Type.Union([
      Type.Literal("P0"),
      Type.Literal("P1"),
      Type.Literal("P2"),
      Type.Literal("P3"),
    ]),
  ),
  effort: Type.Optional(
    Type.Union([
      Type.Literal("XS"),
      Type.Literal("S"),
      Type.Literal("M"),
      Type.Literal("L"),
      Type.Literal("XL"),
    ]),
  ),
  created: Type.Optional(Type.String()),
  owner: Type.Optional(Type.String()),
  assignees: Type.Optional(Type.Array(Type.String())),
  depends_on: Type.Optional(Type.Array(Type.Union([Type.Number(), Type.String()]))),
  tags: Type.Optional(Type.Array(Type.String())),
  evaluation: EvaluationSchema,
});

export type BacklogSpec = Static<typeof BacklogSpecSchema>;
export type AutomatedCheck = Static<typeof AutomatedCheckSchema>;
export type RubricCriterion = Static<typeof RubricCriterionSchema>;

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a parsed YAML object against the BacklogSpec schema.
 * Returns the typed spec or null with a warning message.
 */
function validateSpec(raw: unknown, filePath: string): BacklogSpec | null {
  if (typeof raw !== "object" || raw === null) {
    console.warn(`[backlog-parser] ${filePath}: frontmatter is not an object`);
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // Check required fields.
  if (!("id" in obj)) {
    console.warn(`[backlog-parser] ${filePath}: missing required field "id"`);
    return null;
  }
  if (!("title" in obj) || typeof obj.title !== "string" || !obj.title.trim()) {
    console.warn(`[backlog-parser] ${filePath}: missing or empty required field "title"`);
    return null;
  }
  const validStatuses = ["draft", "ready", "in-progress", "in-review", "done", "cancelled"];
  if (!("status" in obj) || !validStatuses.includes(obj.status as string)) {
    console.warn(
      `[backlog-parser] ${filePath}: "status" must be one of: ${validStatuses.join(", ")}`,
    );
    return null;
  }

  // Warn on unknown top-level fields (security: reject nothing, just warn).
  const knownFields = new Set([
    "id", "title", "status", "priority", "effort", "created",
    "owner", "assignees", "depends_on", "tags", "evaluation",
  ]);
  for (const key of Object.keys(obj)) {
    if (!knownFields.has(key)) {
      console.warn(`[backlog-parser] ${filePath}: unknown frontmatter field "${key}" — ignoring`);
    }
  }

  return obj as BacklogSpec;
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a backlog spec file. Returns null (with a console.warn) if the file
 * cannot be read, has no valid YAML frontmatter, or fails validation.
 * Never throws.
 */
export function parseSpecFile(filePath: string): BacklogSpec | null {
  if (!existsSync(filePath)) {
    console.warn(`[backlog-parser] ${filePath}: file not found`);
    return null;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.warn(`[backlog-parser] ${filePath}: read error — ${String(err)}`);
    return null;
  }

  // Extract YAML frontmatter between the first two --- delimiters.
  // The file may start with an HTML comment (TEMPLATE.md) — skip it.
  const match = content.match(/^(?:<!--[\s\S]*?-->\s*)?---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    console.warn(`[backlog-parser] ${filePath}: no YAML frontmatter found`);
    return null;
  }

  let raw: unknown;
  try {
    raw = parseYaml(match[1]);
  } catch (err) {
    console.warn(`[backlog-parser] ${filePath}: YAML parse error — ${String(err)}`);
    return null;
  }

  return validateSpec(raw, filePath);
}

// ── Status mapping ────────────────────────────────────────────────────────────

/**
 * Map a 6-state BacklogSpec status to the 4-state TaskStatus used by tasks.json.
 *
 *   draft / ready        → queued
 *   in-progress / in-review → in-progress
 *   done                 → done
 *   cancelled            → failed
 */
export function mapStatusToTaskStatus(status: BacklogSpec["status"]): TaskStatus {
  switch (status) {
    case "draft":
    case "ready":
      return "queued";
    case "in-progress":
    case "in-review":
      return "in-progress";
    case "done":
      return "done";
    case "cancelled":
      return "failed";
  }
}

// ── ID helpers ────────────────────────────────────────────────────────────────

/** Normalise a spec id (number or string) to a zero-padded 4-digit string. */
export function normaliseSpecId(id: number | string): string {
  return String(id).padStart(4, "0");
}
