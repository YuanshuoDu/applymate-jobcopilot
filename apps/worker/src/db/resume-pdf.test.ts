import { describe, it, expect } from "vitest";
import { generateResumePdf } from "./resume-pdf.js";
import { statSync, unlinkSync } from "node:fs";

describe("generateResumePdf", () => {
  it("generates PDF file that exists and has content", async () => {
    const path = await generateResumePdf("test-user", {
      personalInfo: { fullName: "Jean Dupont", email: "jean@test.com" },
      skills: ["TypeScript", "React"],
      experience: [
        { title: "Engineer", company: "Acme", startDate: "2020", endDate: "2024" },
      ],
    });
    expect(path).toMatch(/\.pdf$/);
    expect(statSync(path).size).toBeGreaterThan(500);
    // Clean up
    unlinkSync(path);
  });
});
