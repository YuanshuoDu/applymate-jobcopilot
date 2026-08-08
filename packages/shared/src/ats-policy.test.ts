import { describe, expect, it } from "vitest";
import { ATS_POLICIES, getHardRpsLimit, isAtsSourceKey } from "./ats-policy.js";

describe("ATS hard policy", () => {
  it("defines the approved ATS hosts and hard RPS ceilings", () => {
    expect(ATS_POLICIES).toEqual({
      greenhouse: { host: "boards-api.greenhouse.io", rps: 5 },
      lever: { host: "api.lever.co", rps: 5 },
      workday: { host: "myworkdayjobs.com", rps: 1 },
      smartrecruiters: { host: "api.smartrecruiters.com", rps: 5 },
      personio: { host: "jobs.personio.com", rps: 5 },
    });
  });

  it("recognizes only approved source keys", () => {
    expect(isAtsSourceKey("lever")).toBe(true);
    expect(isAtsSourceKey("linkedin")).toBe(false);
  });

  it("returns null when a source has no hard RPS ceiling", () => {
    expect(getHardRpsLimit("workday")).toBe(1);
    expect(getHardRpsLimit("linkedin")).toBeNull();
  });
});
