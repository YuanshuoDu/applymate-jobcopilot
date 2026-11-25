import { describe, it, expect } from "vitest";
import { loadTaskContext, readApplyQueueMaterialMode } from "./load-task-context.js";
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
        accountStatus: "active",
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
    const pool = mockPool({ accountStatus: "active", name: "Jean" }, null);
    await expect(
      loadTaskContext(pool, "user-1", "job-missing", "https://fallback.com")
    ).rejects.toThrow(/job-missing/);
  });

  it("empty personaFields (null): base fields still present", async () => {
    const pool = mockPool(
      { accountStatus: "active", name: "Jean", email: "jean@test.com", phone: null, location: null, linkedin: null, personaFields: null },
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
        accountStatus: "active",
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

  it("loads Objective context without reading resume, answers, or cover-letter material", async () => {
    const calls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        calls.push(String(sql));
        if (sql.includes('"User"')) return { rows: [{ accountStatus: "active", name: "Ada", email: "ada@example.com", personaFields: [] }] };
        if (sql.includes('"Job"')) return { rows: [{ role: "Engineer", company: "Example", keywords: "TypeScript", url: "https://boards.greenhouse.io/acme/jobs/123" }] };
        return { rows: [] };
      },
    } as unknown as Pool;

    const context = await loadTaskContext(pool, "user-1", "job-1", "https://fallback.invalid", "task-1", { objectiveOnly: true });

    expect(context).toMatchObject({ jobTitle: "Engineer", jobCompany: "Example", applyUrl: "https://boards.greenhouse.io/acme/jobs/123",
      coverLetterText: null, confirmedAnswers: {} });
    expect(context.resumeTempPath).toBeUndefined();
    expect(calls.some(sql => sql.includes('FROM "Resume"'))).toBe(false);
    expect(calls.some(sql => sql.includes("confirmedAnswers") || sql.includes("description") || sql.includes('"coverLetter"'))).toBe(false);
  });

  it("does not use a queued URL when the owned Objective Job has no URL", async () => {
    const pool = mockPool({ accountStatus: "active", personaFields: [] }, {
      role: "Engineer", company: "Example", keywords: "TypeScript", url: null,
    });
    await expect(loadTaskContext(pool, "user-1", "job-1", "https://queued.invalid", "task-1", { objectiveOnly: true }))
      .rejects.toThrow("Objective application target is unavailable.");
  });
});

const objectiveSource = {
  schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1",
  approvalId: `objective-review:objective-review-${"a".repeat(40)}:2`,
  reviewTurnId: "review-turn-1",
  materialProofHash: "b".repeat(64),
};

function modePool(input: unknown, events: Array<Record<string, unknown>> = [], failEvents = false): Pool {
  return {
    query: async (sql: string) => {
      if (String(sql).includes("FROM agent_turns")) return { rows: [{ input }] };
      if (String(sql).includes('FROM "application_task_events"')) {
        if (failEvents) throw new Error("unavailable");
        if (String(sql).includes("SELECT EXISTS")) return { rows: [{ present: events.some(event =>
          event.type === "objective_application_review_approved"
          || event.type === "reviewed_application_fill_browser_started"
            && (event.schemaVersion === "agent-harness.v2.objective-reviewed-fill-browser-start.v1" || event.hasObjectiveSource === true)) }] };
        return { rows: events.some(event => event.type === "objective_submission_manifest_recorded") ? [{ id: "manifest-event" }] : [] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
}

const modeIdentity = {
  applicationTaskId: "task-1", userId: "user-1", jobId: "job-1", sessionId: "session-1", fillTurnId: "turn-1",
  approvalId: "receipt-1", constraintHash: "c".repeat(64),
};

describe("readApplyQueueMaterialMode", () => {
  it("selects Objective only from the exact persisted Objective marker", async () => {
    await expect(readApplyQueueMaterialMode(modePool({ reviewedApplicationMaterialSource: objectiveSource }), modeIdentity))
      .resolves.toBe("objective");
  });

  it.each([
    { reviewedApplicationMaterialSource: { ...objectiveSource, extra: true } },
    { reviewedApplicationMaterialSource: { schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v2" } },
  ])("blocks malformed or unknown persisted Objective markers", async input => {
    await expect(readApplyQueueMaterialMode(modePool(input), modeIdentity)).resolves.toBe("blocked");
  });

  it("blocks a removed Objective marker when exact task-scoped V3 evidence remains", async () => {
    const events = [{ type: "objective_application_review_approved", schemaVersion: null, hasObjectiveSource: false }];
    await expect(readApplyQueueMaterialMode(modePool({}, events), modeIdentity)).resolves.toBe("blocked");
  });

  it("blocks a legacy selector if an Objective browser-start or manifest event exists", async () => {
    const selected = { reviewedApplicationMaterialSource: {
      schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-turn-1",
    } };
    const events = [{ type: "reviewed_application_fill_browser_started",
      schemaVersion: "agent-harness.v2.objective-reviewed-fill-browser-start.v1", hasObjectiveSource: true }];
    await expect(readApplyQueueMaterialMode(modePool(selected, events), modeIdentity)).resolves.toBe("blocked");
    await expect(readApplyQueueMaterialMode(modePool({}, [{ type: "objective_submission_manifest_recorded" }]), modeIdentity))
      .resolves.toBe("blocked");
  });

  it("keeps ordinary and selected-job V1 selectors on the existing path", async () => {
    await expect(readApplyQueueMaterialMode(modePool({}), modeIdentity)).resolves.toBe("ordinary");
    await expect(readApplyQueueMaterialMode(modePool({ reviewedApplicationMaterialSource: {
      schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-turn-1",
    } }), modeIdentity)).resolves.toBe("ordinary");
  });

  it("fails closed when the exact persisted mode cannot be read", async () => {
    await expect(readApplyQueueMaterialMode(modePool({}, [], true), modeIdentity)).resolves.toBe("blocked");
  });
});
