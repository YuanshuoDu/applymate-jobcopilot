import { describe, expect, it, vi } from "vitest"
import { createAgentArtifactRepository } from "./agent-artifact-repo.js"

describe("agent artifact repository", () => {
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
    const write = (content: string, hash: string, toolCallId: string, expectedPreviousHash?: string) => repository.saveDraft({
      id: "draft-a", userId: "user-a", jobId: "job-a", artifactType: "cover_letter", content, hash,
      constraintHash: "constraints", provenanceRefs: ["persona:fact-a"], evidenceRefs: ["job:job-a"],
      sessionId: "session-a", baseId: "base-a", baseHash: "base-hash", previousHash: null,
      sourceDigest: "source-a", taskId: "task-a", toolCallId, requestHash: `request-${toolCallId}`, taskFence, expectedPreviousHash,
    })

    const first = await write(body1, "hash-one", "call-one")
    const second = await write(body2, "hash-two", "call-two", first.contentHash)
    const parentWrites = calls.filter(call => call.sql.startsWith('INSERT INTO "agent_artifact"') || call.sql.startsWith('UPDATE "agent_artifact"'))
    const parentContent = parentWrites.map(call => JSON.parse(String(call.sql.startsWith("INSERT") ? call.values[6] : call.values[0])) as unknown)
    expect(parentContent).toEqual([
      { kind: "agent_artifact_version", artifactId: "draft-a", version: 1, contentHash: "hash-one" },
      { kind: "agent_artifact_version", artifactId: "draft-a", version: 2, contentHash: "hash-two" },
    ])
    expect(JSON.stringify(parentContent)).not.toContain(body1)
    expect(JSON.stringify(parentContent)).not.toContain(body2)
    const versionWrites = calls.filter(call => call.sql.startsWith('INSERT INTO "agent_artifact_version"'))
    expect(versionWrites.map(call => JSON.parse(String(call.values[7])) as unknown)).toEqual([body1, body2])
    expect(first.content).toBe(body1)
    expect(second.content).toBe(body2)
  })
})
