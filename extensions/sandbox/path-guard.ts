// Ported from sysid/pi-extensions packages/sandbox/path-guard.ts (MIT License, © sysid).
// https://github.com/sysid/pi-extensions/blob/main/packages/sandbox/path-guard.ts

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

export interface SandboxFilesystemConfig {
  denyRead?: string[];
  allowWrite?: string[];
  denyWrite?: string[];
}

export interface SandboxConfigForGuard {
  filesystem?: SandboxFilesystemConfig;
}

export function expandPath(pattern: string, cwd: string): string {
  if (pattern === "~" || pattern.startsWith("~/")) {
    return resolve(homedir(), pattern.slice(2));
  }
  if (pattern.startsWith("/")) {
    return pattern;
  }
  return resolve(cwd, pattern);
}

export function isUnderDirectory(filePath: string, dirPath: string): boolean {
  const normalizedFile = resolve(filePath);
  const normalizedDir = resolve(dirPath);
  const dirPrefix = normalizedDir === "/" ? "/" : `${normalizedDir}/`;
  if (normalizedFile === normalizedDir || normalizedFile.startsWith(dirPrefix)) {
    return true;
  }
  try {
    const realFile = realpathSync(normalizedFile);
    const realDir = realpathSync(normalizedDir);
    const realDirPrefix = realDir === "/" ? "/" : `${realDir}/`;
    return realFile === realDir || realFile.startsWith(realDirPrefix);
  } catch {
    return false;
  }
}

export function matchesFilePattern(filePath: string, pattern: string): boolean {
  const name = basename(filePath);
  if (pattern.startsWith("*")) {
    return name.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

function resolveFilePath(filePath: string, cwd: string): string {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return resolve(homedir(), filePath.slice(2));
  }
  return resolve(cwd, filePath);
}

export function isReadBlocked(
  filePath: string,
  config: SandboxConfigForGuard,
  cwd: string,
): { blocked: boolean; reason?: string } {
  const denyRead = config.filesystem?.denyRead;
  if (!denyRead || denyRead.length === 0) {
    return { blocked: false };
  }
  const resolved = resolveFilePath(filePath, cwd);
  for (const pattern of denyRead) {
    const expanded = expandPath(pattern, cwd);
    if (isUnderDirectory(resolved, expanded)) {
      return {
        blocked: true,
        reason: `Read denied: ${filePath} is under restricted path ${pattern}`,
      };
    }
  }
  return { blocked: false };
}

export function isWriteBlocked(
  filePath: string,
  config: SandboxConfigForGuard,
  cwd: string,
): { blocked: boolean; reason?: string } {
  const fs = config.filesystem;
  if (!fs) {
    return { blocked: false };
  }
  const resolved = resolveFilePath(filePath, cwd);

  const denyWrite = fs.denyWrite;
  if (denyWrite) {
    for (const pattern of denyWrite) {
      if (matchesFilePattern(resolved, pattern)) {
        return {
          blocked: true,
          reason: `Write denied: ${filePath} matches restricted pattern ${pattern}`,
        };
      }
    }
  }

  const allowWrite = fs.allowWrite;
  if (!allowWrite || allowWrite.length === 0) {
    return {
      blocked: true,
      reason: `Write denied: ${filePath} is not under any allowed write path`,
    };
  }

  for (const pattern of allowWrite) {
    const expanded = expandPath(pattern, cwd);
    if (isUnderDirectory(resolved, expanded)) {
      return { blocked: false };
    }
  }

  return {
    blocked: true,
    reason: `Write denied: ${filePath} is not under any allowed write path`,
  };
}
