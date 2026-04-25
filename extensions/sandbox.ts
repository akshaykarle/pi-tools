// OS-level sandbox extension for the pi coding agent.
//
// Architecture: per-bash-call wrapping via @anthropic-ai/sandbox-runtime's
// SandboxManager library API + in-process tool_call guards. No external
// process wrapper around pi.
//
// Architectural notes:
// - srt's policy precedence is asymmetric: allowRead > denyRead but
//   denyWrite > allowWrite. Our in-process tool guard uses denyRead > allowRead
//   (safer). The OS layer behaves differently — accepted limitation.
// - srt always blocks writes to .bashrc, .gitconfig, .git/hooks/, .mcp.json
//   etc. regardless of allowWrite.
// - Project sandbox.json lives at ./.pi-${profile}/sandbox.json and is
//   opt-in per directory — this extension never auto-creates it.
// - Pi's home-manager-managed dotfiles resolve through /nix/store, which
//   sits inside srt's broad read allowlist. Real secrets (id_ed25519, etc.)
//   remain blocked because they aren't nix-managed.
//
// Helpers in extensions/sandbox/{path-guard,prompt,session-state}.ts are
// MIT-licensed ports from sysid/pi-extensions.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import type { BashOperations } from "@mariozechner/pi-coding-agent";

// BashResult is exported from "@mariozechner/pi-coding-agent/core" but not from
// the top-level entry. Mirror the shape locally — only used to build a
// fail-closed UserBashEventResult.
interface BashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}
import {
  SandboxManager,
  type SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";
import {
  configPaths,
  effectiveStripList,
  loadConfig,
  toSrtRuntimeConfig,
  type SandboxConfig,
} from "./sandbox/config.js";
import {
  expandPath,
  isReadBlocked,
  isUnderDirectory,
  isWriteBlocked,
} from "./sandbox/path-guard.js";
import { promptDomainBlock, promptWriteBlock } from "./sandbox/prompt.js";
import {
  addDomainToConfig,
  addWritePathToConfig,
  createSessionState,
  type SessionState,
} from "./sandbox/session-state.js";

// Module-level state shared across hooks within a single pi process.
let activeConfig: SandboxConfig = {};
let sandboxEnabled = false;
let sandboxInitialized = false;
let sandboxFailed = false;
let toolGuardEnabled = false;
let sessionState: SessionState = createSessionState();
let lastUserPath = "";
let lastProjectPath = "";

function failedBashResult(): BashResult {
  return {
    output: "[sandbox] init failed — bash blocked. Fix config or use --no-sandbox.\n",
    exitCode: 1,
    cancelled: false,
    truncated: false,
  };
}

function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith(`.${base}`);
  }
  return domain === pattern;
}

function isSessionAllowedWrite(filePath: string, cwd: string): boolean {
  for (const allowed of sessionState.writePaths) {
    const expanded = expandPath(allowed, cwd);
    if (isUnderDirectory(filePath, expanded)) return true;
  }
  return false;
}

function applyAllowance(
  choice: "session" | "project" | "global",
  type: "domain" | "writePath",
  value: string,
): void {
  if (type === "domain") {
    sessionState.domains.push(value);
    if (choice === "project") addDomainToConfig(lastProjectPath, value);
    if (choice === "global") addDomainToConfig(lastUserPath, value);
  } else {
    sessionState.writePaths.push(value);
    if (choice === "project") addWritePathToConfig(lastProjectPath, value);
    if (choice === "global") addWritePathToConfig(lastUserPath, value);
  }
  // For project/global, persist the change into srt's live config too.
  if (choice !== "session" && sandboxInitialized) {
    activeConfig = loadConfig(process.cwd());
    SandboxManager.updateConfig(toSrtRuntimeConfig(activeConfig));
  }
}

function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }
      const wrapped = await SandboxManager.wrapWithSandbox(command);
      return new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", wrapped], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

function buildAskCallback(ctx: ExtensionContext): SandboxAskCallback | undefined {
  if (!ctx.hasUI) return undefined;
  return async ({ host }) => {
    if (sessionState.domains.some((d) => domainMatchesPattern(host, d))) return true;
    const choice = await promptDomainBlock(ctx.ui, host);
    if (choice === "abort") return false;
    applyAllowance(choice, "domain", host);
    return true;
  };
}

function statusReport(): string {
  const lines: string[] = ["Sandbox Configuration:", ""];
  const osStatus = sandboxEnabled
    ? "enabled"
    : sandboxFailed
      ? "FAILED (bash blocked)"
      : "disabled";
  lines.push("Status:", `  OS sandbox: ${osStatus}`, `  Tool guard: ${toolGuardEnabled ? "enabled" : "disabled"}`);

  lines.push(
    "",
    "Network:",
    `  Allowed: ${activeConfig.network?.allowedDomains?.join(", ") || "(none)"}`,
    `  Denied:  ${activeConfig.network?.deniedDomains?.join(", ") || "(none)"}`,
  );
  lines.push(
    "",
    "Filesystem:",
    `  Deny Read:   ${activeConfig.filesystem?.denyRead?.join(", ") || "(none)"}`,
    `  Allow Write: ${activeConfig.filesystem?.allowWrite?.join(", ") || "(none)"}`,
    `  Deny Write:  ${activeConfig.filesystem?.denyWrite?.join(", ") || "(none)"}`,
  );

  if (sessionState.domains.length > 0) {
    lines.push("", "Session-allowed domains:", `  ${sessionState.domains.join(", ")}`);
  }
  if (sessionState.writePaths.length > 0) {
    lines.push("", "Session-allowed write paths:", `  ${sessionState.writePaths.join(", ")}`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI): void {
  pi.registerFlag("no-sandbox", {
    description: "Disable all sandbox enforcement (OS sandbox + tool guard).",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    // 1) Always scrub env first — even in escape-hatch modes.
    activeConfig = loadConfig(ctx.cwd);
    const stripList = effectiveStripList(activeConfig);
    for (const k of stripList) delete process.env[k];

    sessionState = createSessionState();
    const paths = configPaths(ctx.cwd);
    lastUserPath = paths.userPath;
    lastProjectPath = paths.projectPath;

    const noSandbox = pi.getFlag("no-sandbox") as boolean;
    if (noSandbox) {
      sandboxEnabled = false;
      sandboxInitialized = false;
      sandboxFailed = false;
      toolGuardEnabled = false;
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    if (activeConfig.enabled === false) {
      sandboxEnabled = false;
      sandboxInitialized = false;
      sandboxFailed = false;
      toolGuardEnabled = false;
      ctx.ui.notify("Sandbox disabled via config (enabled:false)", "info");
      return;
    }

    toolGuardEnabled = true;

    if (!SandboxManager.isSupportedPlatform()) {
      sandboxEnabled = false;
      sandboxInitialized = false;
      ctx.ui.notify(
        `OS sandbox not supported on ${process.platform} (tool guard still active)`,
        "warning",
      );
      return;
    }

    try {
      await SandboxManager.initialize(toSrtRuntimeConfig(activeConfig), buildAskCallback(ctx));
      sandboxEnabled = true;
      sandboxInitialized = true;
      const dom = activeConfig.network?.allowedDomains?.length ?? 0;
      const wr = activeConfig.filesystem?.allowWrite?.length ?? 0;
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒 Sandbox: ${dom} domains, ${wr} write paths`));
      ctx.ui.notify("Sandbox initialized", "info");
    } catch (err) {
      sandboxEnabled = false;
      sandboxInitialized = false;
      sandboxFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(
        `Sandbox init failed: ${msg}. Bash will be BLOCKED (tool guard still active). Fix config or use --no-sandbox.`,
        "error",
      );
    }
  });

  pi.on("user_bash", () => {
    if (sandboxFailed) {
      return { result: failedBashResult() };
    }
    if (!sandboxEnabled || !sandboxInitialized) {
      // Escape hatch (--no-sandbox or enabled:false): pi runs bash itself.
      return undefined;
    }
    return { operations: createSandboxedBashOps() };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!toolGuardEnabled) return undefined;

    const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
    const WRITE_TOOLS = ["write", "edit"] as const;

    for (const tool of READ_TOOLS) {
      if (isToolCallEventType(tool, event)) {
        const path = (event.input as { path?: unknown }).path;
        if (typeof path !== "string") return undefined;
        const result = isReadBlocked(path, activeConfig, ctx.cwd);
        if (result.blocked) {
          ctx.ui.notify(`Sandbox blocked read: ${path}`, "warning");
          return { block: true, reason: result.reason };
        }
        return undefined;
      }
    }

    for (const tool of WRITE_TOOLS) {
      if (isToolCallEventType(tool, event)) {
        const path = (event.input as { path?: unknown }).path;
        if (typeof path !== "string") return undefined;
        const result = isWriteBlocked(path, activeConfig, ctx.cwd);
        if (result.blocked) {
          // denyWrite hits are hard-blocked, no prompt — they protect secrets.
          if (result.reason?.includes("matches restricted pattern")) {
            ctx.ui.notify(`Sandbox blocked write: ${path}`, "warning");
            return { block: true, reason: result.reason };
          }
          if (isSessionAllowedWrite(path, ctx.cwd)) return undefined;
          if (ctx.hasUI) {
            const choice = await promptWriteBlock(ctx.ui, path);
            if (choice !== "abort") {
              applyAllowance(choice, "writePath", path);
              return undefined;
            }
          }
          ctx.ui.notify(`Sandbox blocked write: ${path}`, "warning");
          return { block: true, reason: result.reason };
        }
        return undefined;
      }
    }
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    if (sandboxInitialized) {
      try {
        await SandboxManager.reset();
      } catch {
        // Cleanup errors are not actionable from here.
      }
    }
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration / validate / reload — try /sandbox status",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] || "status";
      switch (sub) {
        case "status":
          ctx.ui.notify(statusReport(), "info");
          return;
        case "show":
          ctx.ui.notify(JSON.stringify(activeConfig, null, 2), "info");
          return;
        case "validate": {
          const paths = configPaths(ctx.cwd);
          const lines: string[] = ["Config validation:"];
          for (const [label, p] of [
            ["user", paths.userPath],
            ["project", paths.projectPath],
          ] as const) {
            if (!existsSync(p)) {
              lines.push(`  ${label} (${p}): not present (defaults apply)`);
              continue;
            }
            try {
              JSON.parse(readFileSync(p, "utf-8"));
              lines.push(`  ${label} (${p}): OK`);
            } catch (e) {
              lines.push(`  ${label} (${p}): INVALID JSON — ${e}`);
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        case "reload": {
          activeConfig = loadConfig(ctx.cwd);
          if (sandboxInitialized) {
            try {
              SandboxManager.updateConfig(toSrtRuntimeConfig(activeConfig));
              ctx.ui.notify("Sandbox config reloaded", "info");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.ui.notify(`Reload failed: ${msg}`, "error");
            }
          } else {
            ctx.ui.notify("Config reloaded (sandbox is not initialized)", "warning");
          }
          return;
        }
        default:
          ctx.ui.notify(
            `Unknown subcommand "${sub}". Try: status | show | validate | reload`,
            "warning",
          );
      }
    },
  });
}

// ----- For tests only — internals exposed via a stable getter. -----

export const __testing__ = {
  reset(): void {
    activeConfig = {};
    sandboxEnabled = false;
    sandboxInitialized = false;
    sandboxFailed = false;
    toolGuardEnabled = false;
    sessionState = createSessionState();
    lastUserPath = "";
    lastProjectPath = "";
  },
  state(): {
    activeConfig: SandboxConfig;
    sandboxEnabled: boolean;
    sandboxInitialized: boolean;
    sandboxFailed: boolean;
    toolGuardEnabled: boolean;
    sessionState: SessionState;
    lastUserPath: string;
    lastProjectPath: string;
  } {
    return {
      activeConfig,
      sandboxEnabled,
      sandboxInitialized,
      sandboxFailed,
      toolGuardEnabled,
      sessionState,
      lastUserPath,
      lastProjectPath,
    };
  },
};

