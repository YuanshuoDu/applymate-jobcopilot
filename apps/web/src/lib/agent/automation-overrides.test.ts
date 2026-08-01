import { describe, expect, it } from "vitest";
import { automationRunOverrides, withAutomationOverrides } from "./automation-overrides";
import type { AgentConfigFull } from "./types";

const config: AgentConfigFull = {
  id: "cfg_1", userId: "user_1", isRunning: false, dailyLimit: 10,
  minMatchScore: 70, autoApply: false, requireApproval: true,
  targetLocations: ["Dublin"], targetRoles: ["Engineer"],
  excludeCompanies: [], priorityCompanies: [], autoCoverLetter: false,
  coverTone: "professional", useTailoredCV: false, model: "MiniMax-M3",
};

describe("automationRunOverrides", () => {
  it("uses the saved automation snapshot rather than the mutable user defaults", () => {
    const overrides = automationRunOverrides({
      automation: {
        targetRoles: ["Backend Engineer"], targetLocations: ["Berlin"],
        minScore: 85, dailyCap: 4, requireApproval: false, autoApply: true,
      },
    });

    expect(overrides).toMatchObject({ minMatchScore: 85, dailyLimit: 4, autoApply: true });
    expect(withAutomationOverrides(config, overrides)).toMatchObject({
      targetRoles: ["Backend Engineer"], targetLocations: ["Berlin"],
      minMatchScore: 85, dailyLimit: 4, requireApproval: false, autoApply: true,
    });
  });

  it("rejects incomplete or malformed snapshots", () => {
    expect(automationRunOverrides({ automation: { targetRoles: ["Engineer"] } })).toBeNull();
    expect(automationRunOverrides({ automation: { targetRoles: [1] } })).toBeNull();
  });
});
