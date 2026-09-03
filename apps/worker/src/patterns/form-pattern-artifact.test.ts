import { describe, expect, it } from "vitest";
import { createFormMappingArtifact } from "./form-pattern-artifact.js";

describe("form mapping artifacts", () => {
  it("is stable, value-free, and includes a reviewable hash", () => {
    const first = createFormMappingArtifact({ "#email": "email", "#name": "fullName" }, "ai");
    const second = createFormMappingArtifact({ "#name": "fullName", "#email": "email" }, "ai");
    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^sha256:/);
    expect(JSON.stringify(first)).not.toContain("candidate@example.com");
  });
});
