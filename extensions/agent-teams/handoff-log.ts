// Agent Teams — append-only handoff log (NDJSON + human-readable markdown).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HandoffEntry, HandoffType } from "./types.js";

function ndjsonPath(runDirPath: string): string {
  return join(runDirPath, "handoffs.ndjson");
}

function markdownPath(runDirPath: string): string {
  return join(runDirPath, "handoffs.md");
}

/**
 * Get the next sequence number for a run's handoff log.
 */
function nextSeq(runDirPath: string): number {
  const entries = loadHandoffs(runDirPath);
  if (entries.length === 0) return 1;
  return Math.max(...entries.map((e) => e.seq)) + 1;
}

/**
 * Append a handoff entry to the NDJSON log and regenerate the markdown file.
 */
export function appendHandoff(
  runDirPath: string,
  opts: {
    type: HandoffType;
    runId: string;
    fromAgent: string;
    toAgent: string;
    taskId: string;
    summary: string;
    artifacts?: string[];
    elapsedMs?: number;
  },
): HandoffEntry {
  const entry: HandoffEntry = {
    timestamp: new Date().toISOString(),
    seq: nextSeq(runDirPath),
    type: opts.type,
    runId: opts.runId,
    fromAgent: opts.fromAgent,
    toAgent: opts.toAgent,
    taskId: opts.taskId,
    summary: opts.summary,
    artifacts: opts.artifacts ?? [],
    elapsedMs: opts.elapsedMs,
  };

  // Append to NDJSON
  appendFileSync(ndjsonPath(runDirPath), JSON.stringify(entry) + "\n", "utf-8");

  // Regenerate markdown
  regenerateMarkdown(runDirPath);

  return entry;
}

/**
 * Load all handoff entries from NDJSON.
 */
export function loadHandoffs(runDirPath: string): HandoffEntry[] {
  const filePath = ndjsonPath(runDirPath);
  if (!existsSync(filePath)) return [];

  const entries: HandoffEntry[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as HandoffEntry);
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

// ── Markdown Generation ──────────────────────────

function typeLabel(type: HandoffType): string {
  switch (type) {
    case "dispatch":
      return "Dispatch";
    case "completion":
      return "Completion";
    case "failure":
      return "Failure";
    case "resume":
      return "Resume";
  }
}

function typeEmoji(type: HandoffType): string {
  switch (type) {
    case "dispatch":
      return "📤";
    case "completion":
      return "✅";
    case "failure":
      return "❌";
    case "resume":
      return "🔄";
  }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  } catch {
    return iso;
  }
}

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return "";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return ` (${secs}s)`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return ` (${mins}m ${remSecs}s)`;
}

/**
 * Regenerate the human-readable handoffs.md from the NDJSON log.
 */
function regenerateMarkdown(runDirPath: string): void {
  const entries = loadHandoffs(runDirPath);
  if (entries.length === 0) return;

  const runId = entries[0].runId;
  const lines: string[] = [`# Handoff Log — ${runId}`, ""];

  for (const entry of entries) {
    lines.push(
      `## ${typeEmoji(entry.type)} #${entry.seq} — ${formatTimestamp(entry.timestamp)} — ${typeLabel(entry.type)}${formatElapsed(entry.elapsedMs)}`,
    );
    lines.push(
      `**${entry.fromAgent} → ${entry.toAgent}** | Task: ${entry.taskId}`,
    );
    lines.push(entry.summary);

    if (entry.artifacts.length > 0) {
      lines.push(
        `📎 Artifacts: ${entry.artifacts.join(", ")}`,
      );
    }
    lines.push("");
  }

  writeFileSync(markdownPath(runDirPath), lines.join("\n"), "utf-8");
}
