// Agent Teams — run lifecycle management.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RunState, RunStatus } from "./types.js";

/** Base directory for all agent-teams runs. */
export function runsRoot(cwd: string): string {
  return join(cwd, ".pi", "agent-teams", "runs");
}

/** Directory for a specific team's runs. */
export function teamRunsDir(cwd: string, teamName: string): string {
  return join(runsRoot(cwd), teamName);
}

/** Directory for a specific run. */
export function runDir(cwd: string, teamName: string, runId: string): string {
  return join(teamRunsDir(cwd, teamName), runId);
}

/** Generate a unique run ID. */
function generateRunId(): string {
  const ts = Date.now();
  const rand = randomBytes(4).toString("hex");
  return `run-${ts}-${rand}`;
}

/** Path to run.json inside a run directory. */
function runStatePath(dir: string): string {
  return join(dir, "run.json");
}

/**
 * Create a new run for a team.
 * Creates the run directory and persists the initial `run.json`.
 */
export function createRun(
  cwd: string,
  teamName: string,
  goal: string,
): RunState {
  const runId = generateRunId();
  const dir = runDir(cwd, teamName, runId);
  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const state: RunState = {
    runId,
    team: teamName,
    goal,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };

  writeFileSync(runStatePath(dir), JSON.stringify(state, null, 2), "utf-8");
  return state;
}

/**
 * Load a run's state from disk.
 * Returns `null` if the file doesn't exist or is invalid.
 */
export function loadRun(
  cwd: string,
  teamName: string,
  runId: string,
): RunState | null {
  const filePath = runStatePath(runDir(cwd, teamName, runId));
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as RunState;
  } catch {
    return null;
  }
}

/**
 * Update a run's status and persist.
 */
export function updateRunStatus(
  cwd: string,
  teamName: string,
  runId: string,
  status: RunStatus,
): RunState | null {
  const state = loadRun(cwd, teamName, runId);
  if (!state) return null;

  state.status = status;
  state.updatedAt = new Date().toISOString();

  const dir = runDir(cwd, teamName, runId);
  writeFileSync(runStatePath(dir), JSON.stringify(state, null, 2), "utf-8");
  return state;
}

/**
 * Check whether a run directory exists.
 */
export function runExists(
  cwd: string,
  teamName: string,
  runId: string,
): boolean {
  return existsSync(runStatePath(runDir(cwd, teamName, runId)));
}
