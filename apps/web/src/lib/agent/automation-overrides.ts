import type { AgentConfigFull } from "./types";

type AutomationFields = {
  targetRoles?: unknown;
  targetLocations?: unknown;
  minScore?: unknown;
  dailyCap?: unknown;
  requireApproval?: unknown;
  autoApply?: unknown;
};

export type AutomationRunOverrides = {
  targetRoles: string[];
  targetLocations: string[];
  minMatchScore: number;
  dailyLimit: number;
  requireApproval: boolean;
  autoApply: boolean;
};

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === "string") ? value : null;
}

/** Safely reads the immutable automation snapshot attached to a run session. */
export function automationRunOverrides(data: unknown): AutomationRunOverrides | null {
  if (!data || typeof data !== "object") return null;
  const automation = (data as { automation?: AutomationFields }).automation;
  if (!automation || typeof automation !== "object") return null;

  const targetRoles = stringArray(automation.targetRoles);
  const targetLocations = stringArray(automation.targetLocations);
  const minScore = automation.minScore;
  const dailyCap = automation.dailyCap;

  if (
    !targetRoles || !targetLocations ||
    typeof minScore !== "number" || !Number.isInteger(minScore) || minScore < 0 || minScore > 100 ||
    typeof dailyCap !== "number" || !Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 50 ||
    typeof automation.requireApproval !== "boolean" || typeof automation.autoApply !== "boolean"
  ) return null;

  return {
    targetRoles,
    targetLocations,
    minMatchScore: minScore,
    dailyLimit: dailyCap,
    requireApproval: automation.requireApproval,
    autoApply: automation.autoApply,
  };
}

export function withAutomationOverrides(
  config: AgentConfigFull,
  overrides: AutomationRunOverrides | null,
): AgentConfigFull {
  return overrides ? { ...config, ...overrides } : config;
}
