import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export interface SandboxEnvConfig {
  strip?: string[];
}

// Our extension-level config: all sections optional so user/project overrides
// can omit what they don't care about. Sections missing everywhere fall back
// to DEFAULT_CONFIG.
export interface SandboxConfig {
  enabled?: boolean;
  network?: SandboxRuntimeConfig["network"];
  filesystem?: SandboxRuntimeConfig["filesystem"];
  ignoreViolations?: SandboxRuntimeConfig["ignoreViolations"];
  enableWeakerNestedSandbox?: boolean;
  enableWeakerNetworkIsolation?: boolean;
  allowPty?: boolean;
  env?: SandboxEnvConfig;
}

export const DEFAULT_STRIP_VARS: string[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_NPM_PASSWORD",
  "AZURE_NPM_USERNAME",
  "ACCERTIFY_NPM_TOKEN",
  "NPM_TOKEN",
  "DATABASE_URL",
  "PRIVATE_KEY",
  "SSH_PRIVATE_KEY",
  "GOOGLE_API_KEY",
  "SLACK_TOKEN",
  "DISCORD_TOKEN",
  "SENDGRID_API_KEY",
  "STRIPE_SECRET_KEY",
  "DOPPLER_TOKEN",
  "VAULT_TOKEN",
  "TAILSCALE_AUTH_KEY",
];

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowedDomains: [
      "api.anthropic.com",
      "*.anthropic.com",
      "api.openai.com",
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "files.pythonhosted.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
      "objects.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.npmrc", "~/.netrc"],
    allowWrite: [".", "/tmp"],
    denyWrite: [
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "id_rsa",
      "id_ed25519",
      "*.pfx",
    ],
  },
  env: {
    strip: DEFAULT_STRIP_VARS,
  },
};

export interface ConfigPaths {
  userPath: string;
  projectPath: string;
}

export function configPaths(cwd: string): ConfigPaths {
  const profileDir = basename(process.env.PI_CODING_AGENT_DIR ?? "") || ".pi";
  return {
    userPath: join(getAgentDir(), "sandbox.json"),
    projectPath: join(cwd, profileDir, "sandbox.json"),
  };
}

function readLayer(path: string, label: string): Partial<SandboxConfig> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch (e) {
    console.error(`[sandbox] Warning: could not parse ${label} config at ${path}: ${e}`);
    return {};
  }
}

// Section-level replace: if a higher-precedence layer defines a key, that
// whole section replaces the lower layer's. env.strip is the ONE exception —
// it's union-only across layers (security-additive).
export function sectionReplaceMerge(
  base: SandboxConfig,
  override: Partial<SandboxConfig>,
): SandboxConfig {
  const result: SandboxConfig = { ...base };
  if (override.enabled !== undefined) result.enabled = override.enabled;
  if (override.network !== undefined) result.network = override.network;
  if (override.filesystem !== undefined) result.filesystem = override.filesystem;
  if (override.ignoreViolations !== undefined) result.ignoreViolations = override.ignoreViolations;
  if (override.enableWeakerNestedSandbox !== undefined) {
    result.enableWeakerNestedSandbox = override.enableWeakerNestedSandbox;
  }
  if (override.enableWeakerNetworkIsolation !== undefined) {
    result.enableWeakerNetworkIsolation = override.enableWeakerNetworkIsolation;
  }
  if (override.allowPty !== undefined) result.allowPty = override.allowPty;

  // env.strip: union across base + override (extend-only, cannot shrink).
  if (override.env?.strip) {
    const union = new Set<string>([
      ...(base.env?.strip ?? []),
      ...override.env.strip,
    ]);
    result.env = { ...(base.env ?? {}), ...(override.env ?? {}), strip: [...union] };
  } else if (override.env !== undefined) {
    // env defined without strip — just merge other env fields on top, strip stays as-is.
    result.env = { ...(base.env ?? {}), ...(override.env ?? {}) };
  }

  return result;
}

export function loadConfig(cwd: string): SandboxConfig {
  const { userPath, projectPath } = configPaths(cwd);
  const userLayer = readLayer(userPath, "user");
  const projectLayer = readLayer(projectPath, "project");
  return sectionReplaceMerge(sectionReplaceMerge(DEFAULT_CONFIG, userLayer), projectLayer);
}

export function effectiveStripList(config: SandboxConfig): string[] {
  // Always includes DEFAULT_STRIP_VARS, union with whatever the merged config carries.
  // Defense in depth — even if someone corrupts the merge, defaults hold.
  return [...new Set<string>([...DEFAULT_STRIP_VARS, ...(config.env?.strip ?? [])])];
}

// Build the SandboxRuntimeConfig that srt's SandboxManager.initialize() expects.
// srt requires network + filesystem to be fully populated; we fill from defaults
// if a layer somehow cleared them.
export function toSrtRuntimeConfig(config: SandboxConfig): SandboxRuntimeConfig {
  const network = config.network ?? DEFAULT_CONFIG.network!;
  const filesystem = config.filesystem ?? DEFAULT_CONFIG.filesystem!;
  const out: SandboxRuntimeConfig = { network, filesystem };
  if (config.ignoreViolations !== undefined) out.ignoreViolations = config.ignoreViolations;
  if (config.enableWeakerNestedSandbox !== undefined) out.enableWeakerNestedSandbox = config.enableWeakerNestedSandbox;
  if (config.enableWeakerNetworkIsolation !== undefined) out.enableWeakerNetworkIsolation = config.enableWeakerNetworkIsolation;
  if (config.allowPty !== undefined) out.allowPty = config.allowPty;
  return out;
}
