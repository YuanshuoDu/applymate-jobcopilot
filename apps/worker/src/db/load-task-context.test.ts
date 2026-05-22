import { describe, it, expect } from "vitest";
import { loadTaskContext } from "./load-task-context.js";
import type { Pool, QueryResult } from "pg";

function mockPool(userRow: Record<string, unknown> | null, jobRow: Record<string, unknown> | null): Pool {
  return {
    query: async (sql: string, params: unknown[]) => {
      const sqlStr = String(sql);
      if (sqlStr.includes('"User"')) {
        return { rows: userRow ? [userRow] : [] } as unknown as QueryResult;
      }
      if (sqlStr.includes('"Job"')) {
        return { rows: jobRow ? [jobRow] : [] } as unknown as QueryResult;
      }
      return { rows: [] } as unknown as QueryResult;
    },
  } as unknown as Pool;
}

describe("loadTaskContext", () => {
  it("happy path: returns correct persona (base + learned merged)", async () => {
    const pool = mockPool(
      {
        name: "Jean Dupont",
        email: "jean@example.com",
        phone: "+33 6 12 34 56 78",
        location: "Paris",
        linkedin: "https://linkedin.com/in/jeandupont",
        personaFields: [
          { key: "workAuthorization", value: "EU Citizen" },
          { key: "noticePeriod", value: "1 month" },
        ],
      },
      {
        role: "Senior Software Engineer",
        company: "Booking.com",
        keywords: "TypeScript, React, Node.js",
        url: "https://boards.greenhouse.io/booking/jobs/12345",
        coverLetter: "Dear Hiring Manager...",
      }
    );

    const ctx = await loadTaskContext(pool, "user-1", "job-1", "https://fallback.com");

    expect(ctx.persona.fullName).toBe("Jean Dupont");
    expect(ctx.persona.email).toBe("jean@example.com");
    expect(ctx.persona.workAuthorization).toBe("EU Citizen");
    expect(ctx.persona.noticePeriod).toBe("1 month");
    expect(ctx.jobTitle).toBe("Senior Software Engineer");
    expect(ctx.jobCompany).toBe("Booking.com");
    expect(ctx.jobKeywords).toBe("TypeScript, React, Node.js");
    expect(ctx.applyUrl).toBe("https://boards.greenhouse.io/booking/jobs/12345");
    expect(ctx.coverLetterText).toBe("Dear Hiring Manager...");
  });

  it("missing job: throws with job ID in message", async () => {
    const pool = mockPool({ name: "Jean" }, null);
    await expect(
      loadTaskContext(pool, "user-1", "job-missing", "https://fallback.com")
    ).rejects.toThrow(/job-missing/);
  });

  it("empty personaFields (null): base fields still present", async () => {
    const pool = mockPool(
      { name: "Jean", email: "jean@test.com", phone: null, location: null, linkedin: null, personaFields: null },
      { role: "Engineer", company: "Corp", keywords: null, url: null, coverLetter: null }
    );

    const ctx = await loadTaskContext(pool, "user-1", "job-1", "https://fallback.com");

    expect(ctx.persona.fullName).toBe("Jean");
    expect(ctx.persona.email).toBe("jean@test.com");
    expect(ctx.persona.phone).toBe("");
    expect(ctx.persona.location).toBe("");
    expect(ctx.jobTitle).toBe("Engineer");
    expect(ctx.jobCompany).toBe("Corp");
    expect(ctx.applyUrl).toBe("https://fallback.com");  // falls back
    expect(ctx.coverLetterText).toBeNull();
  });

  it("personaFields with entries: learned fields merged on top of base", async () => {
    const pool = mockPool(
      {
        name: "Jane",
        email: "jane@test.com",
        personaFields: [
          { key: "workAuthorization", value: "Visa required" },
          { key: "", value: "ignored" },           // empty key → skipped
          { key: "emptyVal", value: "" },           // empty value → skipped
          { key: "salary", value: "€80k" },
        ],
      },
      { role: "Dev", company: "Inc", keywords: "", url: "https://job.com", coverLetter: null }
    );

    const ctx = await loadTaskContext(pool, "user-1", "job-1", "");

    expect(ctx.persona.fullName).toBe("Jane");
    expect(ctx.persona.workAuthorization).toBe("Visa required");
    expect(ctx.persona.salary).toBe("€80k");
    // Empty key/value should NOT appear
    expect(ctx.persona[""]).toBeUndefined();
    expect(ctx.persona.emptyVal).toBeUndefined();
  });
});
