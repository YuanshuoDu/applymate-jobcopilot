import { describe, expect, it } from "vitest"

import {
  readAgentSelectedJobMaterial,
  type AgentSelectedJobMaterialQueryClient,
  type AgentSelectedJobQueryParameter,
} from "./agent-selected-job-material.js"

describe("readAgentSelectedJobMaterial", () => {
  it("uses shared owner-scoped reads and preserves the fixed source digest", async () => {
    const calls: Array<{ sql: string; values: readonly AgentSelectedJobQueryParameter[] }> = []
    const client: AgentSelectedJobMaterialQueryClient = {
      async query<Row>(sql: string, values: readonly AgentSelectedJobQueryParameter[]) {
        calls.push({ sql, values })
        const rows = sql.includes('FROM "Job"') ? [{
          id: "job-1", company: "Example GmbH", role: "Engineer", location: "Berlin", status: "open", score: 8,
          url: "https://jobs.example/1", source: "greenhouse", salary: "EUR 80k", description: "Build systems", keywords: "TypeScript",
          createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"),
        }] : sql.includes('FROM "Resume"') ? [{
          id: "resume-1", name: "Base", kind: "base", origin: "manual", isDefault: true,
          content: { text: "Engineer with TypeScript experience" },
          createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"),
        }] : [{
          id: "fact-1", key: "language", category: "language", value: "English C1", source: "resume",
          sourceRef: "resume:language", confidence: "0.98", allowedUses: ["cover_letter"],
        }]
        return { rows: rows as unknown as readonly Row[] }
      },
    }

    const result = await readAgentSelectedJobMaterial(client, { userId: "user-1", jobId: "job-1" })

    expect(result.preparation).toEqual({
      jobId: "job-1",
      sourceDigest: "sha256:32a674c483f0337f444c15a7dd5dea93d243e739ab846aff905981c24f253a39",
      evidenceRefs: ["job:job-1", "persona:fact-1", "resume:resume-1"],
    })
    expect(result.baseResume.createdAt).toBe("2026-01-01T00:00:00.000Z")
    expect(result.personaFacts[0]?.confidence).toBe(0.98)
    expect(result.transientSources[1]).toEqual({ sourceRef: "resume:resume-1", content: { text: "Engineer with TypeScript experience" } })
    expect(calls.find(call => call.sql.includes('FROM "Job"'))?.values).toEqual(["job-1", "user-1"])
    expect(calls.find(call => call.sql.includes('FROM "Resume"'))?.values).toEqual(["user-1", null])
    expect(calls.find(call => call.sql.includes("FROM persona_facts"))?.values).toEqual(["user-1", null, "cover_letter"])
    expect(calls.every(call => call.sql.trimStart().startsWith("SELECT"))).toBe(true)
  })

  it("rejects an empty owner scope before reading", async () => {
    const client: AgentSelectedJobMaterialQueryClient = {
      async query<Row>() { return { rows: [] as readonly Row[] } },
    }

    await expect(readAgentSelectedJobMaterial(client, { userId: " ", jobId: "job-1" }))
      .rejects.toThrow("selected_job_scope_invalid")
  })
})
