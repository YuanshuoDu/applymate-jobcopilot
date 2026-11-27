import { describe, expect, it, vi } from "vitest"
import type { Pool, PoolClient } from "pg"
import type { AgentArtifactBaseInsert, AgentArtifactDraftWrite } from "../../db/agent-artifact-repo.js"
import type { ScheduledPrepareArtifactWriteBinding, ScheduledPrepareJobInput } from "../tools/scheduled-application-prepare.js"
import type { ScheduledPrepareMaterialSources } from "./scheduled-application-prepare-persistence.js"
import { persistScheduledPrepareMaterial } from "./scheduled-application-prepare-persistence.js"

const { createArtifactRepository, loadSelectedJobArtifactContext } = vi.hoisted(() => ({
  createArtifactRepository: vi.fn(), loadSelectedJobArtifactContext: vi.fn(),
}))
vi.mock("../../db/agent-artifact-repo.js", () => ({ createAgentArtifactRepository: createArtifactRepository }))
vi.mock("./selected-job-artifact-context.js", () => ({ loadSelectedJobArtifactContext }))

const sourceDigest = "sha256:" + "c".repeat(64)
const evidenceRefs = ["job:job-a", "resume:resume-a"]
const source = {
  preparation: { sourceDigest, evidenceRefs },
  baseResumeId: "resume-a",
  transientSources: [
    { sourceRef: "job:job-a", content: { title: "Software Engineer" } },
    { sourceRef: "resume:resume-a", content: { summary: "source resume" } },
  ],
} as unknown as ScheduledPrepareMaterialSources
const binding: ScheduledPrepareArtifactWriteBinding = {
  userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", taskId: "prepare-task-a",
  executionId: "execution-a", executionAttemptCount: 2, taskFence: {
    taskId: "prepare-task-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a",
    parentTaskId: "root-a", leaseOwner: "worker-a", attemptCount: 3,
  },
  continuationKey: "scheduled-taskgraph:key", snapshotDigest: "snapshot-digest", evidenceDigest: "evidence-digest",
  checkpointDigest: "checkpoint-digest", analyzeGraphRevision: 5, prepareScheduleRevision: 6, resumeTailoringChoiceDigest: null,
  jobId: "job-a", score: 80, sourceDigest, evidenceRefs, kind: "resume", toolCallId: "prepare-call-a", requestHash: "request-hash",
}

function createHarness(current: ScheduledPrepareMaterialSources = source, failDraft = false) {
  const events: string[] = []
  const committedWrites: string[] = []
  let stagedWrites: string[] = []
  const client = {
    query: vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql === "BEGIN") events.push("begin")
      else if (sql.includes("hashtextextended")) events.push("source-fence")
      else if (sql === "SELECT pg_current_xact_id()::text AS transaction_id") events.push("source-fence-verify")
      else if (sql.includes("pg_advisory_xact_lock(hashtext($1), hashtext($2))")) events.push("job-advisory")
      else if (sql === "COMMIT") {
        events.push("commit")
        committedWrites.push(...stagedWrites)
        stagedWrites = []
      } else if (sql === "ROLLBACK") {
        events.push("rollback")
        stagedWrites = []
      } else if (sql.startsWith("INSERT ")) {
        events.push(sql.toLowerCase().replaceAll(" ", "-"))
        stagedWrites.push(sql)
      } else if (sql.startsWith("SELECT set_config")) events.push("tenant-scope")
      return {
        rows: sql.includes("pg_current_xact_id()::text AS transaction_id") ? [{ transaction_id: "73" }] : [],
        rowCount: sql.includes("pg_current_xact_id()::text AS transaction_id") ? 1 : 0,
      }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool
  const repository = {
    insertBaseWithClient: vi.fn(async (writeClient: PoolClient, _base: AgentArtifactBaseInsert) => {
      events.push("base-insert-call")
      await writeClient.query("INSERT BASE")
    }),
    saveDraft: vi.fn(async (write: AgentArtifactDraftWrite, writeClient: PoolClient) => {
      events.push("draft-save-call")
      await writeClient.query("INSERT DRAFT HEAD")
      await writeClient.query("INSERT DRAFT VERSION")
      if (failDraft) throw new Error("draft version write failed")
      return { artifactId: write.id, version: 1, contentHash: write.hash, sourceDigest: write.sourceDigest }
    }),
  }
  createArtifactRepository.mockReturnValue(repository)
  loadSelectedJobArtifactContext.mockImplementation(async (readClient: PoolClient, userId: string, jobId: string) => {
    events.push("source-read")
    expect(readClient).toBe(client)
    expect(userId).toBe(binding.userId)
    expect(jobId).toBe(binding.jobId)
    return current
  })
  const input = {
    invocation: { owner: { rootAttemptCount: 2, turnLeaseOwnerId: "turn-owner-current", turnLeaseVersion: 12 } },
    artifactBinding: () => binding,
  } as unknown as ScheduledPrepareJobInput
  return { client, pool, repository, input, events, committedWrites }
}

describe("scheduled Prepare fenced persistence", () => {
  it("locks the source and job before re-reading, then uses one client for base and draft writes", async () => {
    const { client, pool, repository, input, events } = createHarness()

    await expect(persistScheduledPrepareMaterial(pool, input, "resume", { summary: "tailored" }, source))
      .resolves.toMatchObject({ artifactId: expect.any(String), version: 1, sourceDigest })

    expect(events.indexOf("source-fence")).toBeLessThan(events.indexOf("source-fence-verify"))
    expect(events.indexOf("source-fence-verify")).toBeLessThan(events.indexOf("job-advisory"))
    expect(events.indexOf("job-advisory")).toBeLessThan(events.indexOf("source-read"))
    expect(events.indexOf("source-read")).toBeLessThan(events.indexOf("base-insert-call"))
    expect(events.indexOf("base-insert-call")).toBeLessThan(events.indexOf("draft-save-call"))
    expect(events.indexOf("draft-save-call")).toBeLessThan(events.indexOf("commit"))
    expect(repository.insertBaseWithClient).toHaveBeenCalledWith(client, expect.objectContaining({ userId: "user-a", jobId: "job-a" }),
      expect.objectContaining({ taskFenceMode: "scheduled_prepare", turnLeaseOwnerId: "turn-owner-current", turnLeaseVersion: 12 }))
    expect(repository.saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      taskFence: expect.objectContaining({ taskFenceMode: "scheduled_prepare", turnLeaseOwnerId: "turn-owner-current", turnLeaseVersion: 12 }),
      provenanceRefs: evidenceRefs, evidenceRefs,
    }), client)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it("rejects source drift before any artifact insert and rolls back the fenced transaction", async () => {
    const changed = { ...source, preparation: { ...source.preparation, sourceDigest: "sha256:" + "d".repeat(64) } }
    const { pool, repository, input, events, committedWrites } = createHarness(changed)

    await expect(persistScheduledPrepareMaterial(pool, input, "resume", { summary: "tailored" }, source))
      .rejects.toThrow("scheduled_prepare_source_changed")

    expect(events).toContain("source-read")
    expect(events).toContain("rollback")
    expect(events).not.toContain("base-insert-call")
    expect(repository.insertBaseWithClient).not.toHaveBeenCalled()
    expect(repository.saveDraft).not.toHaveBeenCalled()
    expect(committedWrites).toEqual([])
  })

  it("rolls back base, draft head, and version writes when the version write fails", async () => {
    const { pool, repository, input, events, committedWrites } = createHarness(source, true)

    await expect(persistScheduledPrepareMaterial(pool, input, "resume", { summary: "tailored" }, source))
      .rejects.toThrow("draft version write failed")

    expect(repository.insertBaseWithClient).toHaveBeenCalledOnce()
    expect(repository.saveDraft).toHaveBeenCalledOnce()
    expect(events).toContain("insert-base")
    expect(events).toContain("insert-draft-head")
    expect(events).toContain("insert-draft-version")
    expect(events).toContain("rollback")
    expect(events).not.toContain("commit")
    expect(committedWrites).toEqual([])
  })
})
