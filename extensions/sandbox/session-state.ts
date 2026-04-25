// Ported from sysid/pi-extensions packages/sandbox/session-state.ts (MIT License, © sysid).
// https://github.com/sysid/pi-extensions/blob/main/packages/sandbox/session-state.ts
//
// Profile-aware paths are passed in by callers (see sandbox.ts) — this file
// is agnostic to which dir a given sandbox.json lives in.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionState {
  domains: string[];
  writePaths: string[];
}

export function createSessionState(): SessionState {
  return { domains: [], writePaths: [] };
}

interface PartialSandboxConfig {
  network?: { allowedDomains?: string[]; [key: string]: unknown };
  filesystem?: { allowWrite?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

function readOrEmptyConfig(configPath: string): PartialSandboxConfig {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(configPath: string, config: PartialSandboxConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function addDomainToConfig(configPath: string, domain: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.network?.allowedDomains ?? [];
  if (existing.includes(domain)) return;
  config.network = {
    ...config.network,
    allowedDomains: [...existing, domain],
  };
  writeConfig(configPath, config);
}

export function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowWrite ?? [];
  if (existing.includes(pathToAdd)) return;
  config.filesystem = {
    ...config.filesystem,
    allowWrite: [...existing, pathToAdd],
  };
  writeConfig(configPath, config);
}
