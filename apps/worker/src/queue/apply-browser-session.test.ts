import { describe, expect, it } from "vitest";
import { isAllowedAtsDestination } from "./apply-browser-session.js";

describe("application destination guard", () => {
  it("keeps ATS host checks exact and HTTPS-only", () => {
    expect(isAllowedAtsDestination("https://boards.greenhouse.io/acme", "greenhouse", "https://apply.example")).toBe(true);
    expect(isAllowedAtsDestination("https://greenhouse.io.evil.test/apply", "greenhouse", "https://apply.example")).toBe(false);
    expect(isAllowedAtsDestination("http://jobs.lever.co/acme", "lever", "https://apply.example")).toBe(false);
  });

  it("keeps unknown ATS destinations on the approved origin", () => {
    expect(isAllowedAtsDestination("https://apply.example/form", null, "https://apply.example/job")).toBe(true);
    expect(isAllowedAtsDestination("https://other.example/form", null, "https://apply.example/job")).toBe(false);
  });
});
