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
      if (text.includes("FROM persona_facts")) return { rows: [] }
      if (text.includes('FROM "Resume"')) return { rows: [] }
      if (text.includes("FROM application_tasks")) return { rows: [] }
      return { rows: [] }
    }) } as unknown as pg.Pool
    const dataSource = createPostgresReadToolDataSource(pool)

    await dataSource.searchJobs("owner-a", { target: "engineer" })
    await dataSource.getJob("owner-a", "job-1")
    await dataSource.retrievePersona("owner-a", { keys: ["work_authorization"] })
    await dataSource.getBaseResume("owner-a", {})
    await dataSource.getApplicationState("owner-a", { jobId: "job-1" })

    expect(queries).toHaveLength(6)
    for (const query of queries) {
      expect(query.sql.trimStart().toUpperCase()).toMatch(/^SELECT/)
      expect(query.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
      expect(query.values).toContain("owner-a")
    }
  })
})
