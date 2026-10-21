import { describe, expect, it, vi } from "vitest"
import { createAgentArtifactRepository, insertAgentArtifactBaseWithClient, type AgentArtifactSourceDigestReader } from "./agent-artifact-repo.js"
import { withArtifactTransaction } from "./agent-artifact-repo-helpers.js"

type ArtifactTestRow = Record<string, unknown>
type ArtifactLeaseRace = "between_base_and_draft" | "after_version_insert"

function createArtifactTransactionPool(race?: ArtifactLeaseRace) {
  const artifacts = new Map<string, ArtifactTestRow>()
  const versions: ArtifactTestRow[] = []
  let currentLeaseOwner = "turn-worker-a"
  let currentLeaseVersion = 6
  let baseWasInserted = false
  let liveChecks = 0
  let snapshot: { artifacts: Map<string, ArtifactTestRow>; versions: ArtifactTestRow[] } | null = null
  let versionInsertCount = 0
  const result = (rows: ArtifactTestRow[] = []) => ({ rows, rowCount: rows.length })
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql === "BEGIN") {
        snapshot = { artifacts: new Map(artifacts), versions: [...versions] }
        return result()
      }
      if (sql === "COMMIT") { snapshot = null; return result() }
      if (sql === "ROLLBACK") {
        if (snapshot) {
          artifacts.clear()
          for (const [id, row] of snapshot.artifacts) artifacts.set(id, row)
          versions.splice(0, versions.length, ...snapshot.versions)
        }
        snapshot = null
        return result()
      }
      if (sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")) return result()
      if (sql.includes('FROM "sub_agent_tasks" AS task')) {
        const current = values[10] === currentLeaseOwner && values[11] === currentLeaseVersion
        return result(current ? [{ id: "prepare-task-a" }] : [])
      }
      if (sql.includes('FROM "sub_agent_tasks" AS parent')) return result([{ id: "root-task-a" }])
      if (sql.includes('SELECT task."leaseExpiresAt" > clock_timestamp()')) {
        liveChecks += 1
        const live = values[6] === currentLeaseOwner && values[7] === currentLeaseVersion
        if (live && race === "between_base_and_draft" && baseWasInserted && liveChecks === 1) {
          currentLeaseOwner = "turn-worker-b"
          currentLeaseVersion = 7
        }
        return result([{ live } as ArtifactTestRow])
      }
      if (sql.includes('FROM "agent_artifact_version"') && sql.includes('"taskId" = $1')) {
        return result(versions.filter(row => row.taskId === values[0] && row.toolCallId === values[1]))
      }
      if (sql.startsWith("SELECT") && sql.includes('FROM "agent_artifact"')) {
        const row = artifacts.get(String(values[0]))
        return result(row && row.userId === values[1] ? [row] : [])
      }
      if (sql.startsWith('INSERT INTO "agent_artifact"') && sql.includes("'base'")) {
        const id = String(values[0])
        if (artifacts.has(id)) return result()
        const row: ArtifactTestRow = {
          id, userId: values[1], jobId: values[2], artifactType: values[3], lifecycle: "base", baseId: id, baseHash: values[4],
          content: JSON.parse(String(values[5])) as unknown, hash: values[6], constraintHash: values[7], provenanceRefs: values[8], evidenceRefs: values[9],
          previousHash: null, version: 1, createdAt: new Date(), updatedAt: new Date(),
        }
        artifacts.set(id, row)
        baseWasInserted = true
        return result([row])
      }
      if (sql.startsWith('INSERT INTO "agent_artifact"')) {
        const id = String(values[0])
        const row: ArtifactTestRow = {
          id, userId: values[1], jobId: values[2], artifactType: values[3], lifecycle: "draft", baseId: values[4], baseHash: values[5],
          content: JSON.parse(String(values[6])) as unknown, hash: values[7], constraintHash: values[8], provenanceRefs: values[9], evidenceRefs: values[10],
          previousHash: values[11], version: values[12], createdAt: new Date(), updatedAt: new Date(),
        }
        artifacts.set(id, row)
        return result()
      }
      if (sql.startsWith('INSERT INTO "agent_artifact_version"')) {
        versionInsertCount += 1
        const row: ArtifactTestRow = {
          id: values[0], artifactId: values[1], version: values[2], userId: values[3], sessionId: values[4], jobId: values[5], artifactType: values[6],
          content: JSON.parse(String(values[7])) as unknown, contentHash: values[8], sourceDigest: values[9], constraintHash: values[10],
          provenanceRefs: values[11], evidenceRefs: values[12], baseId: values[13], baseHash: values[14], previousHash: values[15],
          taskId: values[16], toolCallId: values[17], requestHash: values[18], createdAt: new Date(),
        }
        versions.push(row)
        if (race === "after_version_insert") { currentLeaseOwner = "turn-worker-b"; currentLeaseVersion = 7 }
        return result([row])
      }
      return result()
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) }
  return { pool, client, artifacts, versions, get currentLeaseOwner() { return currentLeaseOwner },
    get versionInsertCount() { return versionInsertCount } }
}

describe("agent artifact repository", () => {
  it("uses the caller transaction and resolves an idempotent base insert without a unique error", async () => {
    const input = { id: "artifact-a", userId: "user-a", jobId: "job-a", artifactType: "application", content: { answerHash: "hash-a" }, hash: "hash-a",
      constraintHash: "constraints-a", provenanceRefs: ["application-task:task-a"], evidenceRefs: ["application-task:task-a"] }
    const row = { ...input, lifecycle: "base", baseId: input.id, baseHash: input.hash, previousHash: null, version: 1, createdAt: new Date(), updatedAt: new Date() }
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      return sql.startsWith("INSERT") ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 }
    }) }

    await expect(insertAgentArtifactBaseWithClient(client as never, input)).resolves.toMatchObject(row)
    expect(calls[0]?.sql).toContain("ON CONFLICT DO NOTHING RETURNING")
    expect(calls[1]?.sql).toContain('WHERE "id" = $1 AND "userId" = $2')
    expect(calls[1]?.values).toEqual([input.id, input.userId])
  })

  it("rejects an idempotent caller-client insert when the same identity has different content", async () => {
    const input = { id: "artifact-a", userId: "user-a", jobId: "job-a", artifactType: "application", content: {}, hash: "expected",
      constraintHash: "constraints-a", provenanceRefs: ["source-a"], evidenceRefs: ["source-a"] }
    const existing = { ...input, hash: "different", lifecycle: "base", baseId: input.id, baseHash: "different", previousHash: null,
      version: 1, createdAt: new Date(), updatedAt: new Date() }
    const client = { query: vi.fn(async (sql: string) => sql.startsWith("INSERT") ? { rows: [], rowCount: 0 } : { rows: [existing], rowCount: 1 }) }

    await expect(insertAgentArtifactBaseWithClient(client as never, input)).rejects.toMatchObject({ code: "receipt_conflict" })
    expect(client.query).toHaveBeenCalledTimes(2)
  })

  it("checks the captured scheduled Prepare Turn lease before a caller-client base insert", async () => {
    const input = { id: "scheduled-base:stable", userId: "user-a", jobId: "job-a", artifactType: "resume", content: { source: "resume-1" },
      hash: "base-hash-a", constraintHash: "base-hash-a", provenanceRefs: ["resume:1"], evidenceRefs: ["resume:1"] }
    const baseRow = { ...input, lifecycle: "base", baseId: input.id, baseHash: input.hash, previousHash: null, version: 1,
      createdAt: new Date(), updatedAt: new Date() }
    const calls: Array<{ sql: string; values: readonly unknown[] }> = []
    let currentTurnLeaseOwner = "turn-worker-b"
    let currentTurnLeaseVersion = 7
    const client = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values })
        if (sql.includes('FROM "sub_agent_tasks" AS task')) {
          const current = values[10] === currentTurnLeaseOwner && values[11] === currentTurnLeaseVersion
          return { rows: current ? [{ id: "prepare-task-a" }] : [], rowCount: current ? 1 : 0 }
        }
        if (sql.includes('FROM "sub_agent_tasks" AS parent')) return { rows: [{ id: "root-task-a" }], rowCount: 1 }
        if (sql.startsWith('INSERT INTO "agent_artifact"')) return { rows: [baseRow], rowCount: 1 }
        if (sql.includes('SELECT task."leaseExpiresAt" > clock_timestamp()')) return { rows: [{ live: true }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
    }
    const taskFence = {
      taskId: "prepare-task-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-task-a",
      parentTaskId: "root-task-a", leaseOwner: "worker-a", attemptCount: 1, taskFenceMode: "scheduled_prepare" as const,
      turnLeaseOwnerId: "turn-worker-a", turnLeaseVersion: 6,
    }

    await client.query("BEGIN")
    await expect(insertAgentArtifactBaseWithClient(client as never, input, taskFence)).rejects.toMatchObject({ code: "task_fence_denied" })
    expect(calls.some(call => call.sql.startsWith('INSERT INTO "agent_artifact"'))).toBe(false)
    await client.query("ROLLBACK")

    currentTurnLeaseOwner = "turn-worker-a"
    currentTurnLeaseVersion = 6
    await client.query("BEGIN")
    await expect(insertAgentArtifactBaseWithClient(client as never, input, taskFence)).resolves.toMatchObject({ id: input.id, lifecycle: "base" })
    await client.query("COMMIT")
    const fenceIndex = calls.findIndex(call => call.sql.includes('FROM "sub_agent_tasks" AS task'))
    const insertIndex = calls.findIndex(call => call.sql.startsWith('INSERT INTO "agent_artifact"'))
    expect(fenceIndex).toBeGreaterThan(0)
    expect(insertIndex).toBeGreaterThan(fenceIndex)
    expect(calls[fenceIndex]?.sql).toContain('($10 = \'scheduled_prepare\' OR task."context"')
  })

  it("keeps find tenant-scoped and parameterized", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const repository = createAgentArtifactRepository({ query } as never)

    await expect(repository.find("user-a", "artifact-a")).resolves.toBeNull()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE "id" = $1 AND "userId" = $2'), ["artifact-a", "user-a"])
  })

  it("normalizes a typed row returned by the database", async () => {
    const row = {
      id: "artifact-a",
      userId: "user-a",
      jobId: "job-a",
      artifactType: "resume",
      lifecycle: "base",
      baseId: "artifact-a",
      baseHash: "sha256:base",
      content: { summary: "Engineer" },
      hash: "sha256:base",
      constraintHash: "sha256:constraints",
      provenanceRefs: ["resume:artifact-a"],
      evidenceRefs: ["resume:artifact-a"],
      previousHash: null,
      version: 1,
      createdAt: new Date("2026-09-03T00:00:00.000Z"),
      updatedAt: new Date("2026-09-03T00:00:00.000Z"),
    }
    const repository = createAgentArtifactRepository({ query: vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 }) } as never)

    await expect(repository.find("user-a", "artifact-a")).resolves.toMatchObject(row)
  })

  it("reads only a current draft head joined to the exact tenant, session, job, and artifact", async () => {
    const canary = "PRIVATE_DRAFT_BODY_CANARY"
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values })
        if (sql.includes('FROM "agent_artifact" AS artifact')) return { rows: [{
          artifactId: "draft-a", version: 3, contentHash: `sha256:${"a".repeat(64)}`,
          sourceDigest: `sha256:${"b".repeat(64)}`, content: canary,
        }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const repository = createAgentArtifactRepository({ connect: vi.fn(async () => client) } as never)

    const head = await repository.findCurrentDraftHead({ userId: "user-a", sessionId: "session-a", jobId: "job-a", artifactId: "draft-a" })
    const read = calls.find(call => call.sql.includes('FROM "agent_artifact" AS artifact'))!

    expect(head).toEqual({ artifactId: "draft-a", version: 3, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` })
    expect(JSON.stringify(head)).not.toContain(canary)
    expect(read.sql).toContain('artifact."lifecycle" = \'draft\'')
    expect(read.sql).toContain('version_row."sessionId" = $4')
    expect(read.sql).toContain('version_row."contentHash" = artifact."hash"')
    expect(read.sql).not.toContain('artifact."content"')
    expect(read.values).toEqual(["draft-a", "user-a", "job-a", "session-a"])
  })

  it("returns no current head when the exact session version is absent or ambiguous", async () => {
    let rows: Record<string, unknown>[] = []
    const client = {
      query: vi.fn(async (sql: string) => sql.includes('FROM "agent_artifact" AS artifact') ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 }),
      release: vi.fn(),
    }
    const repository = createAgentArtifactRepository({ connect: vi.fn(async () => client) } as never)
    const scope = { userId: "user-a", sessionId: "session-a", jobId: "job-a", artifactId: "draft-a" }

    await expect(repository.findCurrentDraftHead(scope)).resolves.toBeNull()
    rows = [
      { artifactId: "draft-a", version: 3, contentHash: "hash-a", sourceDigest: "source-a" },
      { artifactId: "draft-a", version: 3, contentHash: "hash-a", sourceDigest: "source-a" },
    ]
    await expect(repository.findCurrentDraftHead(scope)).resolves.toBeNull()
  })

  it("returns full needs-revision details only for the exact review, live Writer fence, and unchanged head", async () => {
    const values: Array<{ sql: string; params?: readonly unknown[] }> = []
    const expected = {
      userId: "user-a", sessionId: "session-a", jobId: "job-a", artifactId: "draft-a", version: 2,
      contentHash: "hash-a", sourceDigest: "source-a", currentSourceDigest: "source-a",
      dependencyTaskId: "reviewer-task", reviewHash: "review-hash",
      taskFence: { taskId: "writer-task", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", parentTaskId: "root-a", leaseOwner: "worker-a", attemptCount: 1 },
    }
    const review = {
      id: "review-row", artifactVersionId: "version-row", userId: expected.userId, sessionId: expected.sessionId,
      jobId: expected.jobId, artifactId: expected.artifactId, version: expected.version, contentHash: expected.contentHash,
      sourceDigest: expected.sourceDigest, currentSourceDigest: expected.currentSourceDigest, status: "needs_revision",
      findings: [{ id: "grammar", code: "grammar", severity: "warning", message: "Revise wording", artifactHash: "hash-a", evidence: [] }],
      evidenceRefs: ["resume:1"], taskId: expected.dependencyTaskId, toolCallId: "review-call", requestHash: "request-hash",
      reviewHash: expected.reviewHash, createdAt: new Date(),
    }
    let reviewRows: Record<string, unknown>[] = [review]
    let live = true
    let currentSourceDigest = "source-a"
    let head: Record<string, unknown> = { id: expected.artifactId, userId: expected.userId, jobId: expected.jobId, artifactType: "cover_letter", lifecycle: "draft", version: 2, hash: "hash-a", constraintHash: "constraints", provenanceRefs: [], evidenceRefs: [], createdAt: new Date(), updatedAt: new Date() }
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        values.push({ sql, params })
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("set_config")) return { rows: [], rowCount: 0 }
        if (sql === "SELECT selected_source_digest") return { rows: [{ digest: currentSourceDigest }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: [{ id: expected.taskFence.taskId }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks" AS parent')) return { rows: [{ id: expected.taskFence.parentTaskId }], rowCount: 1 }
        if (sql.includes('SELECT task."leaseExpiresAt" > clock_timestamp()')) return { rows: [{ live }], rowCount: 1 }
        if (sql.includes('FROM "agent_artifact_review"')) return { rows: reviewRows, rowCount: reviewRows.length }
        if (sql.startsWith("SELECT") && sql.includes('FROM "agent_artifact"')) return { rows: [head], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const readCurrentSourceDigest: AgentArtifactSourceDigestReader = async (queryClient, userId, jobId) => {
      expect(queryClient).toBe(client)
      const result = await queryClient.query<{ digest: string }>("SELECT selected_source_digest", [userId, jobId])
      return result.rows[0]?.digest ?? null
    }
    const repository = createAgentArtifactRepository({ connect: vi.fn(async () => client) } as never)
    const exactInput = { ...expected, readCurrentSourceDigest }

    await expect(repository.readRevisionReview(exactInput)).resolves.toMatchObject({ id: "review-row", findings: [{ message: "Revise wording" }] })
    const read = values.find(call => call.sql.includes('FROM "agent_artifact_review"'))!
    expect(read.sql).toContain('"currentSourceDigest"=$8 AND "status"=\'needs_revision\' AND "taskId"=$9 AND "reviewHash"=$10 LIMIT 2')
    expect(read.params).toEqual([expected.userId, expected.sessionId, expected.jobId, expected.artifactId, expected.version,
      expected.contentHash, expected.sourceDigest, expected.currentSourceDigest, expected.dependencyTaskId, expected.reviewHash])
    expect(values.find(call => call.sql.startsWith("SELECT") && call.sql.includes('FROM "agent_artifact"'))?.sql).toContain("FOR UPDATE")
    const readIndex = values.findIndex(call => call.sql.includes('FROM "agent_artifact_review"'))
    const sourceIndex = values.findIndex(call => call.sql === "SELECT selected_source_digest")
    expect(sourceIndex).toBeGreaterThanOrEqual(0)
    expect(sourceIndex).toBeLessThan(readIndex)

    currentSourceDigest = "source-drifted"
    const receiptReadsBeforeDrift = values.filter(call => call.sql.includes('FROM "agent_artifact_review"')).length
    await expect(repository.readRevisionReview(exactInput)).resolves.toBeNull()
    expect(values.filter(call => call.sql.includes('FROM "agent_artifact_review"'))).toHaveLength(receiptReadsBeforeDrift)
    currentSourceDigest = "source-a"

    live = false
    await expect(repository.readRevisionReview(exactInput)).resolves.toBeNull()
    live = true
    head = { ...head, version: 3 }
    await expect(repository.readRevisionReview(exactInput)).resolves.toBeNull()
    head = { ...head, version: 2 }
    reviewRows = []
    await expect(repository.readRevisionReview(exactInput)).resolves.toBeNull()
    await expect(repository.readRevisionReview({ ...exactInput, sourceDigest: "old-source" })).resolves.toBeNull()
  })

  it("reads only receipt metadata for the selected-job completion gate", async () => {
    const scope = {
      userId: "user-a", sessionId: "session-a", jobId: "job-a", artifactId: "draft-a", version: 2,
      contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}`,
      currentSourceDigest: `sha256:${"b".repeat(64)}`, status: "passed" as const, taskId: "reviewer-task-a",
      reviewHash: `sha256:${"c".repeat(64)}`,
    }
    const row = { ...scope, toolCallId: "review-call-a", findings: ["PRIVATE_REVIEW_CANARY"], evidenceRefs: ["private-evidence"], requestHash: "private-request" }
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    let rows: Record<string, unknown>[] = [row]
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values })
        return sql.includes('FROM "agent_artifact_review"') ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const repository = createAgentArtifactRepository({ connect: vi.fn(async () => client) } as never)

    const receipt = await repository.findReviewReceipt(scope)
    const read = calls.find(call => call.sql.includes('FROM "agent_artifact_review"'))!

    expect(receipt).toEqual({ ...scope, toolCallId: row.toolCallId })
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_REVIEW_CANARY")
    expect(read.sql).toContain('"currentSourceDigest"=$8 AND "status"=$9 AND "taskId"=$10 AND "reviewHash"=$11')
    expect(read.sql).toContain('SELECT "userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest", "currentSourceDigest", "status", "taskId", "toolCallId", "reviewHash"')
    expect(read.sql).not.toMatch(/"(findings|evidenceRefs|requestHash)"/)
    expect(read.sql).toContain("LIMIT 2")
    expect(read.values).toEqual([scope.userId, scope.sessionId, scope.jobId, scope.artifactId, scope.version,
      scope.contentHash, scope.sourceDigest, scope.currentSourceDigest, scope.status, scope.taskId, scope.reviewHash])
    rows = [row, { ...row, toolCallId: "second-review-call" }]
    await expect(repository.findReviewReceipt(scope)).resolves.toBeNull()
  })

  it("stores selected-job cover-letter text only in immutable versions", async () => {
    const body1 = "PRIVATE_DRAFT_BODY_ONE"
    const body2 = "PRIVATE_DRAFT_BODY_TWO"
    const calls: Array<{ sql: string; values: readonly unknown[] }> = []
    const baseRow = {
      id: "base-a", userId: "user-a", jobId: "job-a", artifactType: "cover_letter", lifecycle: "base",
      baseId: "base-a", baseHash: "base-hash", content: "base", hash: "base-hash", constraintHash: "base-constraints",
      provenanceRefs: [], evidenceRefs: [], previousHash: null, version: 1, createdAt: new Date(), updatedAt: new Date(),
    }
    let draftRow: Record<string, unknown> | null = null
    const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: [{ id: "task-a" }] }
      if (sql.includes('AS "live"')) return { rows: [{ live: true }] }
      if (sql.includes('FROM "agent_artifact_version"') && sql.includes('"taskId" = $1')) return { rows: [] }
      if (sql.startsWith('SELECT') && sql.includes('FROM "agent_artifact"')) {
        return { rows: values[0] === "base-a" ? [baseRow] : values[0] === "draft-a" && draftRow ? [draftRow] : [] }
      }
      if (sql.startsWith('INSERT INTO "agent_artifact"')) {
        draftRow = {
          id: values[0], userId: values[1], jobId: values[2], artifactType: values[3], lifecycle: "draft",
          baseId: values[4], baseHash: values[5], content: JSON.parse(String(values[6])) as unknown,
          hash: values[7], constraintHash: values[8], provenanceRefs: values[9], evidenceRefs: values[10], previousHash: values[11],
          version: values[12], createdAt: new Date(), updatedAt: new Date(),
        }
        return { rows: [] }
      }
      if (sql.startsWith('UPDATE "agent_artifact"')) {
        draftRow = { ...draftRow, content: JSON.parse(String(values[0])) as unknown, hash: values[1], version: values[6], previousHash: values[5] }
        return { rows: [] }
      }
      if (sql.startsWith('INSERT INTO "agent_artifact_version"')) {
        return { rows: [{
          id: values[0], artifactId: values[1], version: values[2], userId: values[3], sessionId: values[4], jobId: values[5],
          artifactType: values[6], content: JSON.parse(String(values[7])) as unknown, contentHash: values[8], sourceDigest: values[9],
          constraintHash: values[10], provenanceRefs: values[11], evidenceRefs: values[12], baseId: values[13], baseHash: values[14],
          previousHash: values[15], taskId: values[16], toolCallId: values[17], requestHash: values[18], createdAt: new Date(),
        }] }
      }
      return { rows: [] }
    })
    const client = { query, release: vi.fn() }
    const repository = createAgentArtifactRepository({ connect: vi.fn(async () => client) } as never)
    const taskFence = {
      taskId: "task-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "task-a",
      parentTaskId: null, leaseOwner: "worker-a", attemptCount: 1,
    }
    const write = (content: string, hash: string, toolCallId: string, expectedPreviousHash?: string, expectedPreviousVersion?: number) => repository.saveDraft({
      id: "draft-a", userId: "user-a", jobId: "job-a", artifactType: "cover_letter", content, hash,
      constraintHash: "constraints", provenanceRefs: ["persona:fact-a"], evidenceRefs: ["job:job-a"],
      sessionId: "session-a", baseId: "base-a", baseHash: "base-hash", previousHash: null,
      sourceDigest: "source-a", taskId: "task-a", toolCallId, requestHash: `request-${toolCallId}`, taskFence, expectedPreviousHash, expectedPreviousVersion,
    })

    const first = await write(body1, "hash-one", "call-one")
    const second = await write(body2, "hash-one", "call-two", first.contentHash, first.version)
    await expect(write(body1, "hash-one", "call-stale-version", first.contentHash, first.version)).rejects.toMatchObject({ code: "precondition_failed" })
    await expect(write(body2, "hash-two", "call-stale-hash", "stale-hash", second.version)).rejects.toMatchObject({ code: "precondition_failed" })
    const parentWrites = calls.filter(call => call.sql.startsWith('INSERT INTO "agent_artifact"') || call.sql.startsWith('UPDATE "agent_artifact"'))
    const parentContent = parentWrites.map(call => JSON.parse(String(call.sql.startsWith("INSERT") ? call.values[6] : call.values[0])) as unknown)
    expect(parentContent).toEqual([
      { kind: "agent_artifact_version", artifactId: "draft-a", version: 1, contentHash: "hash-one" },
      { kind: "agent_artifact_version", artifactId: "draft-a", version: 2, contentHash: "hash-one" },
    ])
    expect(JSON.stringify(parentContent)).not.toContain(body1)
    expect(JSON.stringify(parentContent)).not.toContain(body2)
    const versionWrites = calls.filter(call => call.sql.startsWith('INSERT INTO "agent_artifact_version"'))
    expect(versionWrites.map(call => JSON.parse(String(call.values[7])) as unknown)).toEqual([body1, body2])
    expect(first.content).toBe(body1)
    expect(second.content).toBe(body2)
  })

  it("fences scheduled Prepare writes by the captured Turn lease before replaying a stable result", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = []
    let currentTurnLeaseOwner = "turn-worker-b"
    let currentTurnLeaseVersion = 7
    const existingVersion = {
      id: "version-a", artifactId: "scheduled-draft:stable", version: 1, userId: "user-a", sessionId: "session-a", jobId: "job-a",
      artifactType: "cover_letter", content: "same-result", contentHash: "hash-a", sourceDigest: "source-a", constraintHash: "constraints-a",
      provenanceRefs: ["persona:fact-a"], evidenceRefs: ["job:job-a"], baseId: "scheduled-base:stable", baseHash: "base-hash-a",
      previousHash: null, taskId: "prepare-task-a", toolCallId: "scheduled-prepare:stable", requestHash: "stable-request-hash", createdAt: new Date(),
    }
    const client = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values })
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 }
        if (sql.includes('FROM "sub_agent_tasks" AS task')) {
          const scheduledPrepareFenceMatches = values[9] !== "scheduled_prepare"
            || (values[10] === currentTurnLeaseOwner && values[11] === currentTurnLeaseVersion)
          return { rows: scheduledPrepareFenceMatches ? [{ id: "prepare-task-a" }] : [], rowCount: scheduledPrepareFenceMatches ? 1 : 0 }
        }
        if (sql.includes('FROM "sub_agent_tasks" AS parent')) return { rows: [{ id: "root-task-a" }], rowCount: 1 }
        if (sql.includes('FROM "agent_artifact_version"') && sql.includes('"taskId" = $1')) return { rows: [existingVersion], rowCount: 1 }
        if (sql.includes('SELECT task."leaseExpiresAt" > clock_timestamp()')) return { rows: [{ live: true }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const repository = createAgentArtifactRepository({ connect: vi.fn(async () => client) } as never)
    const draft = {
      id: "scheduled-draft:stable", userId: "user-a", jobId: "job-a", artifactType: "cover_letter", content: "same-result", hash: "hash-a",
      constraintHash: "constraints-a", provenanceRefs: ["persona:fact-a"], evidenceRefs: ["job:job-a"], sessionId: "session-a",
      baseId: "scheduled-base:stable", baseHash: "base-hash-a", previousHash: null, sourceDigest: "source-a", taskId: "prepare-task-a",
      toolCallId: "scheduled-prepare:stable", requestHash: "stable-request-hash",
    }
    const staleFence = {
      taskId: "prepare-task-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-task-a",
      parentTaskId: "root-task-a", leaseOwner: "worker-a", attemptCount: 1, taskFenceMode: "scheduled_prepare" as const,
      turnLeaseOwnerId: "turn-worker-a", turnLeaseVersion: 6,
    }

    await expect(repository.saveDraft({ ...draft, taskFence: staleFence })).rejects.toMatchObject({ code: "task_fence_denied" })
    expect(calls.some(call => call.sql.includes('FROM "agent_artifact_version"'))).toBe(false)
    expect(calls.some(call => /^(INSERT|UPDATE) INTO? "agent_artifact/.test(call.sql))).toBe(false)

    const replay = await repository.saveDraft({ ...draft, taskFence: { ...staleFence, turnLeaseOwnerId: currentTurnLeaseOwner, turnLeaseVersion: currentTurnLeaseVersion } })
    expect(replay).toMatchObject({ id: "version-a", artifactId: "scheduled-draft:stable", toolCallId: "scheduled-prepare:stable", requestHash: "stable-request-hash" })
    const receiptRead = calls.filter(call => call.sql.includes('FROM "agent_artifact_version"') && call.sql.includes('"taskId" = $1'))
    expect(receiptRead).toHaveLength(1)
    expect(receiptRead[0]?.values).toEqual(["prepare-task-a", "scheduled-prepare:stable"])
    expect(calls.some(call => /^(INSERT|UPDATE) INTO? "agent_artifact/.test(call.sql))).toBe(false)

    currentTurnLeaseOwner = "turn-worker-c"
    currentTurnLeaseVersion = 8
    const currentOwnerReplay = await repository.saveDraft({ ...draft, taskFence: { ...staleFence, turnLeaseOwnerId: currentTurnLeaseOwner, turnLeaseVersion: currentTurnLeaseVersion } })
    expect(currentOwnerReplay.id).toBe("version-a")
    expect(calls.filter(call => call.sql.includes('FROM "agent_artifact_version"') && call.sql.includes('"taskId" = $1'))).toHaveLength(2)
  })

  it("rolls back the scheduled Prepare base when the Turn lease changes before the version write", async () => {
    const database = createArtifactTransactionPool("between_base_and_draft")
    const repository = createAgentArtifactRepository(database.pool as never)
    const taskFence = {
      taskId: "prepare-task-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-task-a",
      parentTaskId: "root-task-a", leaseOwner: "worker-a", attemptCount: 1, taskFenceMode: "scheduled_prepare" as const,
      turnLeaseOwnerId: "turn-worker-a", turnLeaseVersion: 6,
    }
    const base = { id: "scheduled-base:atomic", userId: "user-a", jobId: "job-a", artifactType: "resume", content: { summary: "source" },
      hash: "base-hash", constraintHash: "base-hash", provenanceRefs: ["resume:source"], evidenceRefs: ["resume:source"] }
    const draft = { id: "scheduled-draft:atomic", userId: "user-a", jobId: "job-a", artifactType: "resume", content: { summary: "tailored" },
      hash: "draft-hash", constraintHash: "draft-hash", provenanceRefs: ["resume:source"], evidenceRefs: ["resume:source"], sessionId: "session-a",
      baseId: base.id, baseHash: base.hash, previousHash: null, sourceDigest: "source-digest", taskId: taskFence.taskId,
      toolCallId: "scheduled-prepare:atomic", requestHash: "request-hash", taskFence }
    const persist = () => withArtifactTransaction(database.pool as never, "user-a", async client => {
      await repository.insertBaseWithClient(client, base, taskFence)
      return repository.saveDraft(draft, client)
    })

    await expect(persist()).rejects.toMatchObject({ code: "task_fence_denied" })

    expect(database.currentLeaseOwner).toBe("turn-worker-b")
    expect(database.client.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK")
    expect(database.artifacts.size).toBe(0)
    expect(database.versions).toEqual([])
    expect(database.versionInsertCount).toBe(0)
  })

  it("rolls back base, draft, and version rows when the captured Turn lease expires before commit", async () => {
    const database = createArtifactTransactionPool("after_version_insert")
    const repository = createAgentArtifactRepository(database.pool as never)
    const taskFence = {
      taskId: "prepare-task-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-task-a",
      parentTaskId: "root-task-a", leaseOwner: "worker-a", attemptCount: 1, taskFenceMode: "scheduled_prepare" as const,
      turnLeaseOwnerId: "turn-worker-a", turnLeaseVersion: 6,
    }
    const base = { id: "scheduled-base:atomic", userId: "user-a", jobId: "job-a", artifactType: "resume", content: { summary: "source" },
      hash: "base-hash", constraintHash: "base-hash", provenanceRefs: ["resume:source"], evidenceRefs: ["resume:source"] }
    const draft = { id: "scheduled-draft:atomic", userId: "user-a", jobId: "job-a", artifactType: "resume", content: { summary: "tailored" },
      hash: "draft-hash", constraintHash: "draft-hash", provenanceRefs: ["resume:source"], evidenceRefs: ["resume:source"], sessionId: "session-a",
      baseId: base.id, baseHash: base.hash, previousHash: null, sourceDigest: "source-digest", taskId: taskFence.taskId,
      toolCallId: "scheduled-prepare:atomic", requestHash: "request-hash", taskFence }
    const persist = () => withArtifactTransaction(database.pool as never, "user-a", async client => {
      await repository.insertBaseWithClient(client, base, taskFence)
      return repository.saveDraft(draft, client)
    })

    await expect(persist()).rejects.toMatchObject({ code: "task_fence_denied" })

    expect(database.versionInsertCount).toBe(1)
    expect(database.artifacts.size).toBe(0)
    expect(database.versions).toEqual([])
    expect(database.client.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK")
  })

  it("replays the current owner's scheduled Prepare version without duplicating rows", async () => {
    const database = createArtifactTransactionPool()
    const repository = createAgentArtifactRepository(database.pool as never)
    const taskFence = {
      taskId: "prepare-task-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-task-a",
      parentTaskId: "root-task-a", leaseOwner: "worker-a", attemptCount: 1, taskFenceMode: "scheduled_prepare" as const,
      turnLeaseOwnerId: "turn-worker-a", turnLeaseVersion: 6,
    }
    const base = { id: "scheduled-base:atomic", userId: "user-a", jobId: "job-a", artifactType: "resume", content: { summary: "source" },
      hash: "base-hash", constraintHash: "base-hash", provenanceRefs: ["resume:source"], evidenceRefs: ["resume:source"] }
    const draft = { id: "scheduled-draft:atomic", userId: "user-a", jobId: "job-a", artifactType: "resume", content: { summary: "tailored" },
      hash: "draft-hash", constraintHash: "draft-hash", provenanceRefs: ["resume:source"], evidenceRefs: ["resume:source"], sessionId: "session-a",
      baseId: base.id, baseHash: base.hash, previousHash: null, sourceDigest: "source-digest", taskId: taskFence.taskId,
      toolCallId: "scheduled-prepare:atomic", requestHash: "request-hash", taskFence }
    const persist = () => withArtifactTransaction(database.pool as never, "user-a", async client => {
      await repository.insertBaseWithClient(client, base, taskFence)
      return repository.saveDraft(draft, client)
    })

    const first = await persist()
    const replay = await persist()

    expect(replay).toEqual(first)
    expect(database.artifacts.size).toBe(2)
    expect(database.versions).toHaveLength(1)
    expect(database.versionInsertCount).toBe(1)
  })
})
