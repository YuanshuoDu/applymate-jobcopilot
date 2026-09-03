import { describe, expect, it } from "vitest"
import { PgArtifactToolStore } from "./artifact-store-pg.js"

describe("PgArtifactToolStore durability", () => {
  it("reads the same base and draft from a second store instance", async () => {
    const pool = createFakeArtifactPool()
    const firstWorker = new PgArtifactToolStore(pool)
    const secondWorker = new PgArtifactToolStore(pool)
    const base = await firstWorker.registerBase({ id: "resume-base", type: "resume", userId: "user-a", jobId: "job-a", content: { summary: "Engineer" } })
    const draft = await firstWorker.writeDraft("user-a", { baseArtifactId: base.id, baseHash: base.hash, content: { summary: "Engineer at Example" }, constraints: { jobId: "job-a" }, evidence: [{ sourceRef: "resume:resume-base", content: "Engineer" }], type: "resume" })

    await expect(secondWorker.read("user-a", base.id)).resolves.toMatchObject({ hash: base.hash, lifecycle: "base" })
    await expect(secondWorker.read("user-a", draft.id)).resolves.toMatchObject({ hash: draft.hash, lifecycle: "draft", version: 1 })
    await expect(secondWorker.listForUser("user-a", "job-a")).resolves.toHaveLength(2)
  })

  it("returns null for a cross-tenant read after a worker restart", async () => {
    const pool = createFakeArtifactPool()
    const writer = new PgArtifactToolStore(pool)
    await writer.registerBase({ id: "resume-base", type: "resume", userId: "user-a", jobId: "job-a", content: "base" })
    const restartedWorker = new PgArtifactToolStore(pool)
    await expect(restartedWorker.read("user-b", "resume-base")).resolves.toBeNull()
    await expect(restartedWorker.listForUser("user-b", "job-a")).resolves.toEqual([])
  })
})

type FakeRow = Record<string, unknown>

function createFakeArtifactPool(): import("pg").Pool {
  return new FakeArtifactPool() as unknown as import("pg").Pool
}

class FakeArtifactPool {
  private readonly rows = new Map<string, FakeRow>()

  async connect() {
    return { query: (sql: string, values?: unknown[]) => this.query(sql, values), release: () => undefined }
  }

  async query(sql: string, values: unknown[] = []): Promise<{ rows: FakeRow[]; rowCount: number }> {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("set_config")) return { rows: [], rowCount: 0 }
    if (sql.includes("ORDER BY \"updatedAt\"")) {
      const result = [...this.rows.values()].filter(row => row.userId === values[0] && row.jobId === values[1])
      return { rows: result, rowCount: result.length }
    }
    if (sql.startsWith("SELECT") && sql.includes('WHERE "id" = $1')) {
      const row = this.rows.get(String(values[0]))
      const visible = row && row.userId === values[1] ? row : undefined
      return { rows: visible ? [visible] : [], rowCount: visible ? 1 : 0 }
    }
    if (sql.includes('VALUES ($1, $2, $3, $4, \'base\'')) {
      const now = new Date()
      const row: FakeRow = { id: values[0], userId: values[1], jobId: values[2], artifactType: values[3], lifecycle: "base", baseId: values[0], baseHash: values[4], content: JSON.parse(String(values[5])), hash: values[6], constraintHash: values[7], provenanceRefs: values[8], evidenceRefs: values[8], previousHash: null, version: 1, createdAt: now, updatedAt: now }
      this.rows.set(String(row.id), row)
      return { rows: [row], rowCount: 1 }
    }
    if (sql.includes('VALUES ($1, $2, $3, $4, \'draft\'')) {
      const row: FakeRow = { id: values[0], userId: values[1], jobId: values[2], artifactType: values[3], lifecycle: "draft", baseId: values[4], baseHash: values[5], content: JSON.parse(String(values[6])), hash: values[7], constraintHash: values[8], provenanceRefs: values[9], evidenceRefs: values[9], previousHash: values[10], version: 1, createdAt: new Date(), updatedAt: new Date() }
      this.rows.set(String(row.id), row)
      return { rows: [row], rowCount: 1 }
    }
    throw new Error(`Unhandled fake SQL: ${sql}`)
  }
}
