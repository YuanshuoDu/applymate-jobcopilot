import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { createScheduledApplicationPrepareRuntime, persistScheduledPrepareMaterial, scheduledPrepareArtifactIdentity,
  scheduledPrepareLiveCheckpointBinding } from "./scheduled-application-prepare-runtime.js"
import { SCHEDULED_PREPARE_CHOICE_SCHEMA, type ScheduledPrepareArtifactWriteBinding, type ScheduledPrepareOwner,
  type VerifiedScheduledPrepareInvocation } from "../tools/scheduled-application-prepare.js"
import type { AgentArtifactBaseInsert, AgentArtifactDraftWrite, AgentArtifactRow, AgentArtifactTaskFence, AgentArtifactVersionRow } from "../../db/agent-artifact-repo.js"
import { hashArtifactContent } from "./artifact-adapters.js"
import { buildScheduledTaskGraphContinuationReceipt,
  scheduledTaskGraphStableContinuationKey, type ScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineAttestation } from "./scheduled-automation-pipeline-bridge.js"
import type { TurnQuestionScheduledChoiceBinding } from "../turns/turn-question-contract.js"

const { readScheduledPrepareChoice } = vi.hoisted(() => ({ readScheduledPrepareChoice: vi.fn() }))
const { createArtifactRepository, loadSelectedJobArtifactContext } = vi.hoisted(() => ({
  createArtifactRepository: vi.fn(), loadSelectedJobArtifactContext: vi.fn(),
}))
vi.mock("../turns/turn-question-store.js", () => ({ createPgTurnQuestionStore: () => ({ readScheduledPrepareChoice }) }))
vi.mock("../../db/agent-artifact-repo.js", () => ({ createAgentArtifactRepository: createArtifactRepository }))
vi.mock("./selected-job-artifact-context.js", () => ({ loadSelectedJobArtifactContext }))

const now = new Date("2026-10-21T10:00:00.000Z")
const stableOwner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  executionId: "execution-1", executionAttemptCount: 3 }
const oldOwner: ScheduledPrepareOwner = { ...stableOwner, turnLeaseOwnerId: "turn-lease-old", turnLeaseVersion: 4 }
const currentOwner: ScheduledPrepareOwner = { ...stableOwner, turnLeaseOwnerId: "turn-lease-current", turnLeaseVersion: 9 }
const digest = (char: string) => createHash("sha256").update(char).digest("hex")

function receiptFor(owner: ScheduledPrepareOwner = oldOwner): ScheduledTaskGraphContinuationReceipt {
  const candidate = buildScheduledTaskGraphContinuationReceipt({ owner, continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`,
    snapshotDigest: `sha256:${digest("snapshot")}`, evidenceDigest: digest("evidence"), checkpointDigest: digest("checkpoint"),
    analyzeGraphRevision: 5, prepareScheduleRevision: 6 })
  if (!candidate) throw new Error("receipt fixture invalid")
  return { ...candidate, continuationKey: scheduledTaskGraphStableContinuationKey(candidate)! }
}

function runtime(pool: pg.Pool) {
  return createScheduledApplicationPrepareRuntime({ pool, task: {} as never, lease: {} as never, owner: {} as never,
    resolveModel: async () => ({} as never), authorize: vi.fn(async () => ({ settle: async () => undefined })) as never,
    treeBudget: {} as never, now: () => now })
}

const sourceDigest = `sha256:${"c".repeat(64)}`
const evidenceRefs = ["job:job-1", "resume:resume-1"]

function artifactBinding(overrides: Partial<Omit<ScheduledPrepareArtifactWriteBinding, "taskFence">> & {
  taskFence?: Partial<ScheduledPrepareArtifactWriteBinding["taskFence"]>
} = {}): ScheduledPrepareArtifactWriteBinding {
  const base: ScheduledPrepareArtifactWriteBinding = {
    userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", taskId: "prepare-task-1",
    executionId: "execution-1", executionAttemptCount: 3,
    taskFence: { taskId: "prepare-task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
      parentTaskId: "root-1", leaseOwner: "worker-a", attemptCount: 1 },
    continuationKey: "scheduled-taskgraph:sha256:" + "a".repeat(64), snapshotDigest: `sha256:${"b".repeat(64)}`,
    evidenceDigest: "d".repeat(64), checkpointDigest: "e".repeat(64), analyzeGraphRevision: 5, prepareScheduleRevision: 6,
    resumeTailoringChoiceDigest: null, jobId: "job-1", score: 82, sourceDigest, evidenceRefs, kind: "resume",
    toolCallId: "scheduled-prepare-call", requestHash: "",
  }
  const merged = { ...base, ...overrides, taskFence: { ...base.taskFence, ...overrides.taskFence } }
  return { ...merged, requestHash: overrides.requestHash ?? hashArtifactContent({
    userId: merged.userId, sessionId: merged.sessionId, turnId: merged.turnId, rootTaskId: merged.rootTaskId,
    taskId: merged.taskId, executionId: merged.executionId, executionAttemptCount: merged.executionAttemptCount,
    sourceDigest: merged.sourceDigest, checkpointDigest: merged.checkpointDigest,
    resumeTailoringChoiceDigest: merged.resumeTailoringChoiceDigest, score: merged.score, evidenceRefs: merged.evidenceRefs, kind: merged.kind,
  }) }
}

function prepareSources() {
  return { preparation: { sourceDigest, evidenceRefs }, baseResumeId: "resume-1", transientSources: [
    { sourceRef: "resume:resume-1", content: { summary: "confirmed base resume" } },
    { sourceRef: "job:job-1", content: { title: "Software Engineer" } },
  ] }
}

function installArtifactStore() {
  const bases = new Map<string, AgentArtifactBaseInsert>()
  const baseFences: AgentArtifactTaskFence[] = []
  const heads = new Map<string, AgentArtifactRow>()
  const receipts = new Map<string, { requestHash: string; row: AgentArtifactVersionRow }>()
  const insertBaseWithClient = vi.fn(async (_client: unknown, input: AgentArtifactBaseInsert, taskFence: AgentArtifactTaskFence) => {
    baseFences.push(taskFence)
    const existing = bases.get(input.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(input)) throw Object.assign(new Error("immutable base conflict"), { code: "receipt_conflict" })
    bases.set(input.id, input)
    return input as never
  })
  const find = vi.fn(async (_userId: string, artifactId: string) => heads.get(artifactId) ?? null)
  const saveDraft = vi.fn(async (input: AgentArtifactDraftWrite) => {
    const key = `${input.taskId}\0${input.toolCallId}`, existing = receipts.get(key)
    if (existing) {
      if (existing.requestHash !== input.requestHash) throw Object.assign(new Error("Task tool receipt conflict"), { code: "receipt_conflict" })
      return existing.row
    }
    const row = { id: `version-${receipts.size + 1}`, artifactId: input.id, version: 1, userId: input.userId, sessionId: input.sessionId,
      jobId: input.jobId, artifactType: input.artifactType, content: input.content, contentHash: input.hash, sourceDigest: input.sourceDigest,
      constraintHash: input.constraintHash, provenanceRefs: [...input.provenanceRefs], evidenceRefs: [...input.evidenceRefs], baseId: input.baseId,
      baseHash: input.baseHash, previousHash: input.previousHash, taskId: input.taskId, toolCallId: input.toolCallId,
      requestHash: input.requestHash, createdAt: new Date() } as AgentArtifactVersionRow
    receipts.set(key, { requestHash: input.requestHash, row })
    heads.set(input.id, { id: input.id, userId: input.userId, jobId: input.jobId, artifactType: input.artifactType, lifecycle: "draft",
      baseId: input.baseId, baseHash: input.baseHash, content: input.content, hash: input.hash, constraintHash: input.constraintHash,
      provenanceRefs: [...input.provenanceRefs], evidenceRefs: [...input.evidenceRefs], previousHash: input.previousHash,
      version: 1, createdAt: new Date(), updatedAt: new Date() })
    return row
  })
  const repository = { insertBaseWithClient, find, saveDraft }
  createArtifactRepository.mockReturnValue(repository)
  return { bases, baseFences, receipts, saveDraft }
}

function persist(pool: pg.Pool, binding: ScheduledPrepareArtifactWriteBinding) {
  const sources = prepareSources()
  loadSelectedJobArtifactContext.mockResolvedValue(sources)
  const input = { invocation: { owner: currentOwner }, artifactBinding: () => binding }
  return persistScheduledPrepareMaterial(pool, input as never, "resume", { summary: "tailored output" }, sources as never)
}

function artifactPool(): pg.Pool {
  const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }
  return { connect: vi.fn(async () => client) } as unknown as pg.Pool
}

describe("scheduled Prepare production runtime", () => {
  it("reloads the exact durable answer under the current Turn lease before preparation", async () => {
    const receipt = receiptFor(), answerBinding: TurnQuestionScheduledChoiceBinding = {
      schemaVersion: "agent-harness.v2.scheduled-prepare-choice-wait.v1", owner: stableOwner,
      continuationKey: receipt.continuationKey, snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest,
      checkpointDigest: receipt.checkpointDigest, analyzeGraphRevision: receipt.analyzeGraphRevision,
      prepareScheduleRevision: receipt.prepareScheduleRevision, finalStepId: "final-step-1", finalStepOrdinal: 8, finalStepAttempt: 1,
    }
    readScheduledPrepareChoice.mockResolvedValue({ status: "answered", waitId: "wait-1", itemId: "agent-wait:question:wait-1",
      answer: "keep_resume", binding: answerBinding })
    const pool = { query: vi.fn(async () => ({ rows: [{ leaseExpiresAt: new Date("2026-10-21T10:01:00.000Z") }] })) } as unknown as pg.Pool
    const invocation = { owner: currentOwner, receipt } as VerifiedScheduledPrepareInvocation
    const resolution = await runtime(pool).resolveResumeTailoringChoice({ invocation, context: {} as never })

    expect(readScheduledPrepareChoice).toHaveBeenCalledWith({
      owner: { kind: "turn", userId: currentOwner.userId, sessionId: currentOwner.sessionId, turnId: currentOwner.turnId,
        taskId: currentOwner.rootTaskId, rootTaskId: currentOwner.rootTaskId, ownerId: currentOwner.turnLeaseOwnerId,
        leaseVersion: currentOwner.turnLeaseVersion, leaseExpiresAt: new Date("2026-10-21T10:01:00.000Z") }, receipt, now,
    })
    expect(resolution).toMatchObject({ status: "answered", choice: { key: receipt.continuationKey, value: "keep_resume",
      questionId: "wait-1", answerItemId: "agent-wait:question:wait-1", schemaVersion: SCHEDULED_PREPARE_CHOICE_SCHEMA, owner: currentOwner } })
  })

  it("separates the stable receipt key from the transient checkpoint key after lease reacquisition", () => {
    const receipt = receiptFor(), attestation: ScheduledAutomationPipelineAttestation = {
      schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1",
      owner: { userId: currentOwner.userId, sessionId: currentOwner.sessionId, turnId: currentOwner.turnId,
        rootTaskId: currentOwner.rootTaskId, rootAttemptCount: currentOwner.rootAttemptCount,
        turnLeaseOwnerId: currentOwner.turnLeaseOwnerId, turnLeaseVersion: currentOwner.turnLeaseVersion },
      snapshotDigest: receipt.snapshotDigest, graphRevision: receipt.analyzeGraphRevision,
      scout: { taskId: "scout-1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest("scout"),
        candidateJobIds: ["job-1"], discoveryReceipt: { status: "complete", taskId: "scout-1", attemptCount: 1,
          completedCalls: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest("discovery") } },
      analyst: { taskId: "analyst-1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest("analyst"),
        dependsOnTaskIds: ["scout-1"], jobIds: ["job-1"] }, evidenceDigest: receipt.evidenceDigest,
    }
    const live = scheduledPrepareLiveCheckpointBinding(receipt, currentOwner, attestation)
    const transient = scheduledTaskGraphContinuationKey(currentOwner, attestation, receipt.owner.executionId, receipt.owner.executionAttemptCount)

    expect(scheduledTaskGraphStableContinuationKey(receipt)).toBe(receipt.continuationKey)
    expect(live?.continuationKey).toBe(transient)
    expect(transient).not.toBe(receipt.continuationKey)
    expect(live?.owner).toMatchObject({ turnLeaseOwnerId: currentOwner.turnLeaseOwnerId, turnLeaseVersion: currentOwner.turnLeaseVersion,
      executionId: oldOwner.executionId, executionAttemptCount: oldOwner.executionAttemptCount })
  })

  it("replays the same material reference across a Worker restart and lease retry", async () => {
    const store = installArtifactStore(), pool = artifactPool(), original = artifactBinding()
    const retry = artifactBinding({ taskFence: { ...original.taskFence, leaseOwner: "worker-b", attemptCount: 2 }, requestHash: original.requestHash })

    const first = await persist(pool, original), replay = await persist(pool, retry)

    expect(replay).toEqual(first)
    expect(store.receipts.size).toBe(1)
    expect(store.bases.size).toBe(1)
    expect(store.saveDraft).toHaveBeenCalledTimes(2)
    expect(store.baseFences[0]).toBe(store.saveDraft.mock.calls[0]?.[0]?.taskFence)
    expect(store.baseFences[0]).toMatchObject({ taskFenceMode: "scheduled_prepare", turnLeaseOwnerId: currentOwner.turnLeaseOwnerId,
      turnLeaseVersion: currentOwner.turnLeaseVersion })
  })

  it("keeps the source base stable but gives a later execution attempt its own material identity", async () => {
    const store = installArtifactStore(), pool = artifactPool(), firstBinding = artifactBinding()
    const laterBinding = artifactBinding({ executionAttemptCount: firstBinding.executionAttemptCount + 1 })
    const firstIdentity = scheduledPrepareArtifactIdentity(firstBinding, 2), laterIdentity = scheduledPrepareArtifactIdentity(laterBinding, 2)

    const first = await persist(pool, firstBinding), later = await persist(pool, laterBinding)

    expect(laterIdentity.baseId).toBe(firstIdentity.baseId)
    expect(laterIdentity.baseConstraintHash).toBe(firstIdentity.baseConstraintHash)
    expect(laterIdentity.draftId).not.toBe(firstIdentity.draftId)
    expect(laterIdentity.toolCallId).not.toBe(firstIdentity.toolCallId)
    expect(later.artifactId).not.toBe(first.artifactId)
    expect(store.bases.size).toBe(1)
    expect(store.receipts.size).toBe(2)
  })

  it("fails closed if checkpoint or choice semantics change inside one execution attempt", async () => {
    const store = installArtifactStore(), pool = artifactPool(), original = artifactBinding()
    const changed = artifactBinding({ checkpointDigest: "f".repeat(64), resumeTailoringChoiceDigest: "a".repeat(64) })
    const firstIdentity = scheduledPrepareArtifactIdentity(original, 2), changedIdentity = scheduledPrepareArtifactIdentity(changed, 2)

    await persist(pool, original)
    await expect(persist(pool, changed)).rejects.toMatchObject({ code: "receipt_conflict" })

    expect(changedIdentity.baseId).toBe(firstIdentity.baseId)
    expect(changedIdentity.baseConstraintHash).toBe(firstIdentity.baseConstraintHash)
    expect(changedIdentity.draftId).toBe(firstIdentity.draftId)
    expect(changedIdentity.toolCallId).toBe(firstIdentity.toolCallId)
    expect(changedIdentity.constraintHash).not.toBe(firstIdentity.constraintHash)
    expect(changed.requestHash).not.toBe(original.requestHash)
    expect(store.receipts.size).toBe(1)
    expect(store.bases.size).toBe(1)
  })
})
