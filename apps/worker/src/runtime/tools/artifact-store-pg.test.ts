import { describe, expect, it } from "vitest"
import type { Pool } from "pg"
import { hashArtifactContent } from "../subagents/artifact-adapters.js"
import { PgArtifactToolStore } from "./artifact-store-pg.js"
import { createSelectedJobPreparation, type ArtifactToolScope } from "./artifact-tools.js"

const prep = createSelectedJobPreparation("job-a", [{ sourceRef: "resume:r-1", content: { skills: ["TypeScript"] } }])
function scopeFor(taskId = "task-a", toolCallId = "call-a"): ArtifactToolScope {
  return { userId: "user-a", sessionId: "session-a", taskId, toolCallId, taskFence: { taskId, userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", parentTaskId: "root-a", leaseOwner: "worker-a", attemptCount: 1 }, ...prep }
}
const scope = scopeFor()

describe("PgArtifactToolStore immutable persistence", () => {
  it("persists, reads exact versions and reviews across store instances", async () => {
    const pool = new FakeArtifactPool() as unknown as Pool
    const writer = new PgArtifactToolStore(pool)
    const base = await writer.registerBase({ id: "base-a", type: "cover_letter", userId: scope.userId, jobId: scope.jobId, content: "base" })
    const input = { baseArtifactId: base.id, baseHash: base.hash, content: "draft", constraints: { maxWords: 300 }, requestHash: hashArtifactContent("request") }
    const version = await writer.writeDraft(scope, input)
    const restarted = new PgArtifactToolStore(pool)
    await expect(restarted.readVersion(scope, { artifactId: version.artifactId, version: 1, contentHash: version.contentHash, sourceDigest: version.sourceDigest })).resolves.toMatchObject({ content: input.content, sessionId: scope.sessionId, jobId: scope.jobId })
    const review = await restarted.saveReview({ userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId, artifactId: version.artifactId, version: 1, contentHash: version.contentHash, sourceDigest: version.sourceDigest, currentSourceDigest: version.sourceDigest, status: "passed", findings: [], evidenceRefs: [...scope.evidenceRefs], taskId: scope.taskId, toolCallId: "review-call", requestHash: hashArtifactContent("review"), reviewHash: hashArtifactContent("review result"), taskFence: scope.taskFence })
    await expect(writer.findReview(scope, { artifactId: version.artifactId, version: 1, contentHash: version.contentHash, sourceDigest: version.sourceDigest })).resolves.toMatchObject({ id: review.id, status: "passed", contentHash: version.contentHash })
  })

  it("returns the original task receipt on replay and rejects conflicting reuse", async () => {
    const pool = new FakeArtifactPool() as unknown as Pool
    const store = new PgArtifactToolStore(pool)
    const base = await store.registerBase({ id: "base-a", type: "cover_letter", userId: scope.userId, jobId: scope.jobId, content: "base" })
    const input = { baseArtifactId: base.id, baseHash: base.hash, content: "draft", constraints: {}, requestHash: hashArtifactContent("same") }
    const first = await store.writeDraft(scope, input)
    await expect(store.writeDraft(scope, input)).resolves.toEqual(first)
    await expect(store.writeDraft(scope, { ...input, content: "changed", requestHash: hashArtifactContent("changed") })).rejects.toMatchObject({ code: "receipt_conflict" })
    expect((await store.listForUser(scope.userId, scope.jobId)).find(row => row.lifecycle === "draft")).toMatchObject({ version: 1, hash: first.contentHash })
  })

  it.each([
    ["stale owner", (pool: FakeArtifactPool) => { pool.fence.leaseOwner = "worker-b" }],
    ["stale attempt", (pool: FakeArtifactPool) => { pool.fence.attemptCount = 2 }],
    ["Stop requested", (pool: FakeArtifactPool) => { pool.fence.interruptRequestedAt = new Date() }],
    ["expired lease", (pool: FakeArtifactPool) => { pool.fence.leaseExpiresAt = new Date(0) }],
    ["stopped root", (pool: FakeArtifactPool) => { pool.fence.rootInterrupted = true }],
    ["terminal Turn", (pool: FakeArtifactPool) => { pool.fence.turnStatus = "interrupted" }],
    ["wrong selected job", (pool: FakeArtifactPool) => { pool.fence.selectedJobId = "job-b" }],
  ])("denies a draft write for %s before creating a version", async (_label, makeStale) => {
    const pool = new FakeArtifactPool()
    const store = new PgArtifactToolStore(pool as unknown as Pool)
    const base = await store.registerBase({ id: "base-a", type: "cover_letter", userId: scope.userId, jobId: scope.jobId, content: "base" })
    makeStale(pool)
    await expect(store.writeDraft(scope, { baseArtifactId: base.id, baseHash: base.hash, content: "draft", constraints: {}, requestHash: hashArtifactContent("denied") }))
      .rejects.toMatchObject({ code: "task_fence_denied" })
    await expect(store.listForUser(scope.userId, scope.jobId)).resolves.toHaveLength(1)
  })

  it("denies a review receipt after a parent Stop request", async () => {
    const pool = new FakeArtifactPool()
    const store = new PgArtifactToolStore(pool as unknown as Pool)
    const base = await store.registerBase({ id: "base-a", type: "cover_letter", userId: scope.userId, jobId: scope.jobId, content: "base" })
    const version = await store.writeDraft(scope, { baseArtifactId: base.id, baseHash: base.hash, content: "draft", constraints: {}, requestHash: hashArtifactContent("review draft") })
    pool.fence.parentInterrupted = true
    await expect(store.saveReview({ userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId, artifactId: version.artifactId, version: 1, contentHash: version.contentHash, sourceDigest: version.sourceDigest, currentSourceDigest: version.sourceDigest, status: "passed", findings: [], evidenceRefs: [...scope.evidenceRefs], taskId: scope.taskId, toolCallId: "review-call", requestHash: hashArtifactContent("stopped review"), reviewHash: hashArtifactContent("review result"), taskFence: scope.taskFence }))
      .rejects.toMatchObject({ code: "task_fence_denied" })
    expect(pool.reviewReceipts.size).toBe(0)
  })

  it("rejects a passed review when its selected-source digest changed", async () => {
    const pool = new FakeArtifactPool()
    const store = new PgArtifactToolStore(pool as unknown as Pool)
    const base = await store.registerBase({ id: "base-a", type: "cover_letter", userId: scope.userId, jobId: scope.jobId, content: "base" })
    const version = await store.writeDraft(scope, { baseArtifactId: base.id, baseHash: base.hash, content: "draft", constraints: {}, requestHash: hashArtifactContent("review draft") })

    await expect(store.saveReview({
      userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId, artifactId: version.artifactId, version: 1,
      contentHash: version.contentHash, sourceDigest: version.sourceDigest, currentSourceDigest: hashArtifactContent("changed source"),
      status: "passed", findings: [], evidenceRefs: [...scope.evidenceRefs], taskId: scope.taskId, toolCallId: "review-call",
      requestHash: hashArtifactContent("changed review"), reviewHash: hashArtifactContent("review result"), taskFence: scope.taskFence,
    })).rejects.toMatchObject({ code: "stale_source" })
    expect(pool.reviewReceipts.size).toBe(0)
  })
})

type Row = Record<string, unknown>
type Result = { rows: Row[]; rowCount: number }
class FakeArtifactPool {
  private readonly artifacts = new Map<string, Row>()
  private readonly versions = new Map<string, Row>()
  private readonly versionReceipts = new Map<string, Row>()
  private readonly reviews = new Map<string, Row>()
  readonly reviewReceipts = new Map<string, Row>()
  readonly fence = {
    leaseOwner: "worker-a", attemptCount: 1, status: "running", interruptRequestedAt: null as Date | null,
    leaseExpiresAt: new Date("2099-01-01T00:00:00Z"), sessionStatus: "active", turnStatus: "waiting",
    turnUserId: "user-a", turnRootTaskId: "root-a", rootStatus: "waiting", rootInterrupted: false,
    parentStatus: "waiting", parentInterrupted: false, selectedJobId: "job-a",
  }
  async connect() { return { query: (sql: string, values?: unknown[]) => this.query(sql, values), release: () => undefined } }
  async query(sql: string, values: unknown[] = []): Promise<Result> {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("selectedJobPreparation")) {
      const valid = (values[0] === "task-a" || values[0] === "review-task") && values[1] === "user-a" && values[2] === "session-a"
        && values[3] === "turn-a" && values[4] === "root-a" && values[5] === "root-a" && values[6] === this.fence.leaseOwner
        && values[7] === this.fence.attemptCount && values[8] === "job-a" && this.fence.status === "running"
        && this.fence.interruptRequestedAt === null && this.fence.leaseExpiresAt.getTime() > Date.now()
        && this.fence.sessionStatus !== "aborted" && this.fence.sessionStatus !== "archived" && this.fence.turnUserId === "user-a"
        && !["completed", "failed", "interrupted", "cancelled"].includes(this.fence.turnStatus) && this.fence.turnRootTaskId === "root-a"
        && !["completed", "failed", "interrupted", "cancelled", "closed"].includes(this.fence.rootStatus) && !this.fence.rootInterrupted
        && this.fence.selectedJobId === "job-a"
      return this.one(valid ? { id: values[0] } : undefined)
    }
    if (sql.includes('FROM "sub_agent_tasks" AS parent')) {
      const valid = values[0] === "root-a" && values[1] === "session-a" && values[2] === "turn-a" && values[3] === "root-a"
        && !this.fence.parentInterrupted && !["completed", "failed", "interrupted", "cancelled", "closed"].includes(this.fence.parentStatus)
      return this.one(valid ? { id: values[0] } : undefined)
    }
    if (sql.includes('SELECT "leaseExpiresAt" > clock_timestamp() AS "live"')) {
      const live = values[0] === "task-a" && values[1] === "session-a" && values[2] === this.fence.leaseOwner
        && values[3] === this.fence.attemptCount && this.fence.leaseExpiresAt.getTime() > Date.now()
      return this.one({ live })
    }
    if (sql.includes('FROM "agent_artifact_version"') && sql.includes('WHERE "taskId" = $1')) return this.one(this.versionReceipts.get(`${values[0]}:${values[1]}`))
    if (sql.includes('FROM "agent_artifact_review"') && sql.includes('WHERE "taskId" = $1')) return this.one(this.reviewReceipts.get(`${values[0]}:${values[1]}`))
    if (sql.startsWith("SELECT") && sql.includes('FROM "agent_artifact_version"')) {
      const row = [...this.versions.values()].find(value => value.userId === values[0] && value.sessionId === values[1] && value.jobId === values[2] && value.artifactId === values[3] && value.version === values[4] && (values[5] === undefined || value.contentHash === values[5]) && (values[6] === undefined || value.sourceDigest === values[6]))
      return this.one(row)
    }
    if (sql.startsWith("SELECT") && sql.includes('FROM "agent_artifact_review"')) {
      const row = [...this.reviews.values()].find(value => value.userId === values[0] && value.sessionId === values[1] && value.jobId === values[2] && value.artifactId === values[3] && value.version === values[4] && value.contentHash === values[5] && value.sourceDigest === values[6])
      return this.one(row)
    }
    if (sql.startsWith("SELECT") && sql.includes('FROM "agent_artifact"') && sql.includes('"id" = $1')) return this.one(this.artifacts.get(`${values[1]}:${values[0]}`))
    if (sql.startsWith("SELECT") && sql.includes('FROM "agent_artifact"') && sql.includes('"jobId" = $2')) {
      const rows = [...this.artifacts.values()].filter(row => row.userId === values[0] && row.jobId === values[1])
      return { rows, rowCount: rows.length }
    }
    if (sql.startsWith("INSERT INTO \"agent_artifact_version\"")) {
      const receipt = `${values[16]}:${values[17]}`
      if (this.versionReceipts.has(receipt)) return this.empty()
      const row: Row = { id: values[0], artifactId: values[1], version: values[2], userId: values[3], sessionId: values[4], jobId: values[5], artifactType: values[6], content: JSON.parse(String(values[7])), contentHash: values[8], sourceDigest: values[9], constraintHash: values[10], provenanceRefs: values[11], evidenceRefs: values[12], baseId: values[13], baseHash: values[14], previousHash: values[15], taskId: values[16], toolCallId: values[17], requestHash: values[18], createdAt: new Date() }
      this.versions.set(`${row.artifactId}:${row.version}`, row); this.versionReceipts.set(receipt, row)
      return this.one(row)
    }
    if (sql.startsWith("INSERT INTO \"agent_artifact_review\"")) {
      const receipt = `${values[13]}:${values[14]}`
      if (this.reviewReceipts.has(receipt)) return this.empty()
      const row: Row = { id: values[0], artifactVersionId: values[1], userId: values[2], sessionId: values[3], jobId: values[4], artifactId: values[5], version: values[6], contentHash: values[7], sourceDigest: values[8], currentSourceDigest: values[9], status: values[10], findings: JSON.parse(String(values[11])), evidenceRefs: values[12], taskId: values[13], toolCallId: values[14], requestHash: values[15], reviewHash: values[16], createdAt: new Date() }
      this.reviews.set(`${receipt}:${row.artifactId}:${row.version}`, row); this.reviewReceipts.set(receipt, row)
      return this.one(row)
    }
    if (sql.startsWith("INSERT INTO \"agent_artifact\"")) {
      const isBase = sql.includes("'base'")
      const row: Row = isBase
        ? { id: values[0], userId: values[1], jobId: values[2], artifactType: values[3], lifecycle: "base", baseId: values[0], baseHash: values[4], content: JSON.parse(String(values[5])), hash: values[6], constraintHash: values[7], provenanceRefs: values[8], evidenceRefs: values[9], previousHash: null, version: 1, createdAt: new Date(), updatedAt: new Date() }
        : { id: values[0], userId: values[1], jobId: values[2], artifactType: values[3], lifecycle: "draft", baseId: values[4], baseHash: values[5], content: JSON.parse(String(values[6])), hash: values[7], constraintHash: values[8], provenanceRefs: values[9], evidenceRefs: values[10], previousHash: values[11], version: values[12], createdAt: new Date(), updatedAt: new Date() }
      this.artifacts.set(`${row.userId}:${row.id}`, row); return this.one(row)
    }
    if (sql.startsWith("UPDATE \"agent_artifact\"")) {
      const row = this.artifacts.get(`${values[8]}:${values[7]}`)
      if (row) Object.assign(row, { content: JSON.parse(String(values[0])), hash: values[1], constraintHash: values[2], provenanceRefs: values[3], evidenceRefs: values[4], previousHash: values[5], version: values[6] })
      return this.one(row)
    }
    throw new Error(`Unexpected artifact SQL: ${sql}`)
  }
  private empty(): Result { return { rows: [], rowCount: 0 } }
  private one(row?: Row): Result { return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } }
}
