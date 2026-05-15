// Backlog dashboard — keyboard shortcut and display configuration.
//
// Config file location: <agentDir>/extensions/backlog-dashboard.json
// The file is optional — all fields have defaults.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DashboardConfig {
  /** Key combination to toggle the widget visibility. Default: "ctrl+b" */
  toggleKey?: string;
  /** Key combination to open the expanded rankings view. Default: "ctrl+B" */
  expandKey?: string;
  /** Set to true to disable the dashboard entirely. Default: false */
  disabled?: boolean;
}

export const DEFAULT_CONFIG: Required<DashboardConfig> = {
  toggleKey: "ctrl+b",
  expandKey: "ctrl+B",
  disabled: false,
};

/**
 * Load dashboard config from <agentDir>/extensions/backlog-dashboard.json.
 * Returns defaults merged with any user overrides. Never throws.
 */
export function loadDashboardConfig(agentDir: string): Required<DashboardConfig> {
  const configPath = join(agentDir, "extensions", "backlog-dashboard.json");
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<DashboardConfig>;
    return {
      toggleKey: raw.toggleKey ?? DEFAULT_CONFIG.toggleKey,
      expandKey: raw.expandKey ?? DEFAULT_CONFIG.expandKey,
      disabled: raw.disabled ?? DEFAULT_CONFIG.disabled,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
