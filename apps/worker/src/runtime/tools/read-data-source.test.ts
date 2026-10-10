import type pg from "pg"
import { describe, expect, it, vi } from "vitest"

import { createPostgresReadToolDataSource } from "./read-data-source.js"

describe("Postgres read tool data source", () => {
  it("uses owner-scoped parameterized SELECT statements for every read", async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = []
    const pool = { query: vi.fn(async (sql: unknown, values: readonly unknown[] = []) => {
      queries.push({ sql: String(sql), values })
      const text = String(sql)
      if (text.includes('FROM "Job"') && text.includes('LIMIT $5')) return { rows: [] }
      if (text.includes('FROM "Job"')) return { rows: [] }
      if (text.includes("FROM persona_facts")) return { rows: [{
        id: "fact-1", key: "work_authorization", category: "eligibility", value: "EU citizen",
        source: "resume", sourceRef: "resume-1", confidence: "0.92", allowedUses: ["cover_letter"],
      }] }
      if (text.includes('FROM "Resume"')) return { rows: [] }
      if (text.includes("FROM application_tasks")) return { rows: [] }
      return { rows: [] }
    }) } as unknown as pg.Pool
    const dataSource = createPostgresReadToolDataSource(pool)

    await dataSource.searchJobs("owner-a", { target: "engineer" })
    await dataSource.getJob("owner-a", "job-1")
    const persona = await dataSource.retrievePersona("owner-a", { keys: ["work_authorization"], useCase: "cover_letter" })
    await dataSource.getBaseResume("owner-a", {})
    await dataSource.getApplicationState("owner-a", { jobId: "job-1" })

    expect(queries).toHaveLength(6)
    const personaQuery = queries.find((query) => query.sql.includes("FROM persona_facts"))
    expect(personaQuery?.sql).toContain('"confidence", "allowedUses"')
    expect(personaQuery?.sql).toContain('AND ($3::text IS NULL OR $3 = ANY("allowedUses"))')
    expect(personaQuery?.sql).toContain('"expires_at" > statement_timestamp()')
    expect(personaQuery?.sql).toContain('ORDER BY "updated_at" DESC, "id" DESC LIMIT 50')
    expect(personaQuery?.values).toEqual(["owner-a", ["work_authorization"], "cover_letter"])
    expect(persona.facts[0]?.allowedUses).toEqual(["cover_letter"])
    expect(queries.find((query) => query.sql.includes('FROM "Resume"'))?.sql).toContain(
      'ORDER BY "isDefault" DESC, "updatedAt" DESC, "id" DESC LIMIT 1',
    )
    for (const query of queries) {
      expect(query.sql.trimStart().toUpperCase()).toMatch(/^SELECT/)
      expect(query.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
      expect(query.values).toContain("owner-a")
    }
  })

  it("bounds outcome counts to the latest 100 owner jobs and distinct linked job-kind pairs", async () => {
    const statuses = ["saved", "applied", "interview", "offer", "rejected"]
    const jobRows = Array.from({ length: 101 }, (_, index) => ({
      id: `private-job-id-${index}`, status: statuses[index % statuses.length]!, updatedAt: new Date(2026, 0, 101 - index),
    }))
    const linkedRows = [
      { job_id: "private-job-id-0", kind: "application_received" },
      { job_id: "private-job-id-0", kind: "application_received" },
      { job_id: "private-job-id-1", kind: "application_received" },
      { job_id: "private-job-id-0", kind: "interview_invitation" },
      { job_id: "private-job-id-2", kind: "offer" },
      { job_id: "private-job-id-3", kind: "rejection" },
      { job_id: "private-job-id-4", kind: "application_update" },
      { job_id: "private-job-id-100", kind: "offer" },
      { job_id: "outside-sample-job", kind: "offer" },
    ]
    const queries: Array<{ sql: string; values: readonly unknown[] }> = []
    const pool = { query: vi.fn(async (sql: unknown, values: readonly unknown[] = []) => {
      const text = String(sql)
      queries.push({ sql: text, values })
      return { rows: text.includes('FROM "Job"') ? jobRows : linkedRows }
    }) } as unknown as pg.Pool
    const dataSource = createPostgresReadToolDataSource(pool)

    const result = await dataSource.getOutcomesSummary("owner-a")

    expect(result).toEqual({
      schemaVersion: 1, advisoryOnly: true,
      coverage: { basis: "latest_100_jobs_by_updatedAt", jobCount: 100, truncated: true },
      jobStatusCounts: { saved: 20, applied: 20, interview: 20, offer: 20, rejected: 20 },
      linkedJobsByGmailKind: { application_received: 2, interview_invitation: 1, offer: 1, rejection: 1, application_update: 1 },
      gmailSemantics: { classification: "heuristic_advisory_only", matchConfidence: "job_linkage_only" },
    })
    expect(queries).toHaveLength(2)
    expect(queries[0]?.sql).toContain('SELECT "id", "status", "updatedAt" FROM "Job"')
    expect(queries[0]?.sql).toContain('WHERE "userId" = $1')
    expect(queries[0]?.sql).toContain('ORDER BY "updatedAt" DESC, "id" DESC LIMIT $2')
    expect(queries[0]?.values).toEqual(["owner-a", 101])
    expect(queries[1]?.sql).toContain('SELECT DISTINCT "job_id", "kind" FROM "gmail_messages"')
    expect(queries[1]?.sql).toContain('WHERE "user_id" = $1 AND "job_id" = ANY($2::text[])')
    expect(queries[1]?.sql).toContain('"kind"::text = ANY($3::text[])')
    expect(queries[1]?.sql).not.toMatch(/subject|sender|excerpt|gmail_message_id|received_at|match_confidence/i)
    expect(queries[1]?.values).toEqual([
      "owner-a", jobRows.slice(0, 100).map(row => row.id),
      ["application_received", "interview_invitation", "offer", "rejection", "application_update"],
    ])
    const encoded = JSON.stringify(result)
    expect(encoded).not.toContain("private-job-id")
    expect(encoded).not.toContain("outside-sample-job")
    expect(encoded).not.toContain("2026-")
    expect(encoded).not.toContain("owner-a")
  })

  it("returns a fixed empty summary and skips Gmail lookup when there are no jobs", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool
    const result = await createPostgresReadToolDataSource(pool).getOutcomesSummary("owner-empty")

    expect(result).toEqual({
      schemaVersion: 1, advisoryOnly: true,
      coverage: { basis: "latest_100_jobs_by_updatedAt", jobCount: 0, truncated: false },
      jobStatusCounts: { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0 },
      linkedJobsByGmailKind: { application_received: 0, interview_invitation: 0, offer: 0, rejection: 0, application_update: 0 },
      gmailSemantics: { classification: "heuristic_advisory_only", matchConfidence: "job_linkage_only" },
    })
    expect(pool.query).toHaveBeenCalledTimes(1)
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE "userId" = $1'), ["owner-empty", 101])
  })
})
