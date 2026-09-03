import { describe, expect, it } from "vitest"
import type { Pool } from "pg"
import { InMemoryArtifactToolStore, type ArtifactBaseInput, type ArtifactToolRecord, type ArtifactToolStore } from "./artifact-tools.js"
import { PgArtifactToolStore } from "./artifact-store-pg.js"

export function createFakeArtifactPool(): Pool {
  return new FakeArtifactPool() as unknown as Pool
}

function baseInput(overrides: Partial<ArtifactBaseInput> = {}): ArtifactBaseInput {
  return { id: "resume-base", type: "resume", userId: "user-a", jobId: "job-a", content: { summary: "Engineer" }, ...overrides }
}

export function runArtifactStoreContract(name: string, create: () => ArtifactToolStore): void {
  describe(`${name} ArtifactToolStore contract`, () => {
    it("registers and reads an owned base artifact", async () => {
      const store = create()
      const base = await store.registerBase(baseInput())
      await expect(store.read("user-a", base.id)).resolves.toMatchObject({ lifecycle: "base", jobId: "job-a", version: 1 })
    })

    it("writes a draft and lists only the requested job", async () => {
      const store = create()
      const base = await store.registerBase(baseInput())
      const draft = await store.writeDraft("user-a", { baseArtifactId: base.id, baseHash: base.hash, content: { summary: "Engineer at Example" }, constraints: { jobId: "job-a" }, evidence: [{ sourceRef: "resume:resume-base", content: "Engineer" }], type: "resume" })
      expect(draft).toMatchObject({ lifecycle: "draft", baseArtifactId: base.id, version: 1, jobId: "job-a" })
      await expect(store.listForUser("user-a", "job-a")).resolves.toHaveLength(2)
      await expect(store.listForUser("user-a", "job-b")).resolves.toEqual([])
    })

    it("rejects a stale base hash", async () => {
      const store = create()
      const base = await store.registerBase(baseInput())
      await expect(store.writeDraft("user-a", { baseArtifactId: base.id, baseHash: "sha256:stale", content: "draft", constraints: {}, evidence: [{ sourceRef: "resume:base", content: "Engineer" }], type: "resume" })).rejects.toMatchObject({ code: "stale_hash" })
    })

    it("rejects a draft without evidence", async () => {
      const store = create()
      const base = await store.registerBase(baseInput())
      await expect(store.writeDraft("user-a", { baseArtifactId: base.id, baseHash: base.hash, content: "draft", constraints: {}, evidence: [], type: "resume" })).rejects.toMatchObject({ code: "invalid_provenance" })
    })

    it("does not expose or write another tenant's artifact", async () => {
      const store = create()
      const base = await store.registerBase(baseInput())
      await expect(store.read("user-b", base.id)).resolves.toBeNull()
      await expect(store.writeDraft("user-b", { baseArtifactId: base.id, baseHash: base.hash, content: "draft", constraints: {}, evidence: [{ sourceRef: "resume:base", content: "Engineer" }], type: "resume" })).rejects.toMatchObject({ code: "not_found" })
    })

    it("rejects duplicate base registration", async () => {
      const store = create()
      await store.registerBase(baseInput())
      await expect(Promise.resolve().then(() => store.registerBase(baseInput({ id: "resume-base-2" })))).rejects.toThrow(/cannot be overwritten/)
    })

    it("increments draft versions when the previous hash matches", async () => {
      const store = create()
      const base = await store.registerBase(baseInput())
      const first = await store.writeDraft("user-a", { artifactId: "resume-draft", baseArtifactId: base.id, baseHash: base.hash, content: "one", constraints: {}, evidence: [{ sourceRef: "resume:base", content: "Engineer" }], type: "resume" })
      const second = await store.writeDraft("user-a", { artifactId: first.id, baseArtifactId: base.id, baseHash: base.hash, content: "two", constraints: {}, expectedPreviousHash: first.hash, evidence: [{ sourceRef: "resume:base", content: "Engineer" }], type: "resume" })
      expect(second.version).toBe(2)
      expect(second.hash).not.toBe(first.hash)
    })

    it("rejects a stale draft update precondition", async () => {
      const store = create()
      const base = await store.registerBase(baseInput())
      const draft = await store.writeDraft("user-a", { baseArtifactId: base.id, baseHash: base.hash, content: "one", constraints: {}, evidence: [{ sourceRef: "resume:base", content: "Engineer" }], type: "resume" })
      await expect(store.writeDraft("user-a", { artifactId: draft.id, baseArtifactId: base.id, baseHash: base.hash, content: "two", constraints: {}, expectedPreviousHash: "sha256:stale", evidence: [{ sourceRef: "resume:base", content: "Engineer" }], type: "resume" })).rejects.toMatchObject({ code: "precondition_failed" })
    })

    it("does not replace a base artifact with a draft", async () => {
      const store = create()
      const base = await store.registerBase(baseInput())
      await expect(store.writeDraft("user-a", { artifactId: base.id, baseArtifactId: base.id, baseHash: base.hash, content: "changed", constraints: {}, evidence: [{ sourceRef: "resume:base", content: "Engineer" }], type: "resume" })).rejects.toMatchObject({ code: "precondition_failed" })
    })

    it("does not reuse a draft id for another job", async () => {
      const store = create()
      const firstBase = await store.registerBase(baseInput())
      const secondBase = await store.registerBase(baseInput({ id: "resume-base-2", jobId: "job-b" }))
      const firstDraft = await store.writeDraft("user-a", { baseArtifactId: firstBase.id, baseHash: firstBase.hash, content: "one", constraints: {}, evidence: [{ sourceRef: "resume:base", content: "Engineer" }], type: "resume" })
      await expect(store.writeDraft("user-a", { artifactId: firstDraft.id, baseArtifactId: secondBase.id, baseHash: secondBase.hash, content: "two", constraints: {}, evidence: [{ sourceRef: "resume:base-2", content: "Engineer" }], type: "resume" })).rejects.toMatchObject({ code: "precondition_failed" })
    })

    it("keeps tenant and job boundaries in list results", async () => {
      const store = create()
      await store.registerBase(baseInput())
      await store.registerBase(baseInput({ id: "cover-base", type: "cover_letter" }))
      await store.registerBase(baseInput({ id: "other-base", userId: "user-b", jobId: "job-b" }))
      const records = await store.listForUser("user-a", "job-a")
      expect(records).toHaveLength(2)
      expect(records.every(record => record.ownerUserId === "user-a" && record.jobId === "job-a")).toBe(true)
    })
  })
}

runArtifactStoreContract("InMemory", () => new InMemoryArtifactToolStore())
runArtifactStoreContract("Postgres", () => new PgArtifactToolStore(createFakeArtifactPool()))

type FakeRow = Record<string, unknown>

class FakeArtifactPool {
  private readonly rows = new Map<string, FakeRow>()

  async connect(): Promise<{ query: (sql: string, values?: unknown[]) => Promise<{ rows: FakeRow[]; rowCount: number }>; release: () => void }> {
    return { query: (sql, values) => this.query(sql, values), release: () => undefined }
  }

  async query(sql: string, values: unknown[] = []): Promise<{ rows: FakeRow[]; rowCount: number }> {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("set_config")) return { rows: [], rowCount: 0 }
    if (sql.includes("ORDER BY \"updatedAt\"")) {
      const result = [...this.rows.values()].filter(row => row.userId === values[0] && row.jobId === values[1]).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      return { rows: result, rowCount: result.length }
    }
    if (sql.startsWith("SELECT") && sql.includes('WHERE "id" = $1')) {
      const row = this.rows.get(String(values[0]))
      const visible = row && row.userId === values[1] ? row : undefined
      return { rows: visible ? [visible] : [], rowCount: visible ? 1 : 0 }
    }
    if (sql.startsWith("UPDATE")) {
      const row = this.rows.get(String(values[5]))
      if (!row || row.userId !== values[6] || row.lifecycle !== "draft") return { rows: [], rowCount: 0 }
      row.content = JSON.parse(String(values[0]))
      row.hash = values[1]
      row.constraintHash = values[2]
      row.provenanceRefs = values[3]
      row.evidenceRefs = values[3]
      row.previousHash = values[4]
      row.version = Number(row.version) + 1
      row.updatedAt = new Date()
      return { rows: [row], rowCount: 1 }
    }
    if (sql.includes('VALUES ($1, $2, $3, $4, \'base\'')) {
      const duplicate = [...this.rows.values()].some(row => row.id === values[0] || (row.userId === values[1] && row.jobId === values[2] && row.lifecycle === "base" && row.artifactType === values[3]))
      if (duplicate) throw { code: "23505" }
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
