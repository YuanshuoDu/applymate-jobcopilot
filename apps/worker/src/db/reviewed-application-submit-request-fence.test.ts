import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  withExactAttemptFence: vi.fn(),
  acquireSourceMaterialFence: vi.fn(),
  hasReviewedSubmissionArtifact: vi.fn(),
  readReviewedApplicationSubmitMaterial: vi.fn(),
  hasObjectiveSubmissionManifestEvidence: vi.fn(),
  readObjectiveReviewedApplicationSubmitMaterial: vi.fn(),
}))
vi.mock("../queue/application-submit-fence.js", () => ({ withExactAttemptFence: mocks.withExactAttemptFence }))
vi.mock("./source-material-fence.js", () => ({ acquireSourceMaterialFence: mocks.acquireSourceMaterialFence }))
vi.mock("./reviewed-application-submit-material.js", () => ({
  hasReviewedSubmissionArtifact: mocks.hasReviewedSubmissionArtifact,
  readReviewedApplicationSubmitMaterial: mocks.readReviewedApplicationSubmitMaterial,
}))
vi.mock("./objective-reviewed-application-submit-material.js", () => ({
  hasObjectiveSubmissionManifestEvidence: mocks.hasObjectiveSubmissionManifestEvidence,
  readObjectiveReviewedApplicationSubmitMaterial: mocks.readObjectiveReviewedApplicationSubmitMaterial,
}))

import { withReviewedApplicationSubmitRequestFence } from "./reviewed-application-submit-request-fence.js"

const scope = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", fillTurnId: "turn_1", applicationTaskId: "task_1",
  jobId: "job_1", approvalId: "approval_1", constraintHash: "b".repeat(64), workerTaskId: "worker_1", executionId: "execution_1",
}
const source = (sourceTurnId = "source-turn-1") => ({
  reviewedApplicationMaterialSource: { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId },
})
const resourceHash = "a".repeat(64), materialHash = "c".repeat(64), answersHash = "d".repeat(64)
const objectiveSource = {
  schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1",
  approvalId: `objective-review:objective-review-${"e".repeat(40)}:2`,
  reviewTurnId: "review-turn-1", materialProofHash: "f".repeat(64),
} as const
const objectiveTurnInput = { reviewedApplicationMaterialSource: objectiveSource }
const approval = {
  userId: scope.userId, sessionId: scope.sessionId, turnId: scope.fillTurnId, taskId: scope.applicationTaskId, jobId: scope.jobId,
  toolCallId: `application-submit:${scope.applicationTaskId}`, type: "submit_application", status: "consumed",
  payload: { applicationTaskId: scope.applicationTaskId, coverLetterId: null, jobId: scope.jobId, resumeId: "resume_1" },
  resourceHash, materialHash, answersHash, scopeHash: scope.constraintHash,
  expiresAt: new Date("2026-12-01T00:00:00.000Z"), decidedAt: new Date("2026-11-20T00:00:00.000Z"),
  consumedAt: new Date("2026-11-20T00:01:00.000Z"),
}
const attempt = { userId: scope.userId, jobId: scope.jobId, receiptId: scope.approvalId, constraintHash: scope.constraintHash, artifactHash: resourceHash, state: "reserved" }
const startEvent = {
  approvalId: scope.approvalId, applicationTaskId: scope.applicationTaskId, constraintHash: scope.constraintHash,
  executionId: scope.executionId, fillTurnId: scope.fillTurnId, jobId: scope.jobId, sessionId: scope.sessionId,
  userId: scope.userId, workerTaskId: scope.workerTaskId,
}

function fixture(options: {
  phase?: "marker" | "boundary"; inputs?: unknown[]; taskCheckpoint?: string; taskWorkerTaskId?: string | null; attempt?: typeof attempt | null;
  approval?: typeof approval | null; event?: unknown; proof?: unknown;
} = {}) {
  const phase = options.phase ?? "marker", inputs = options.inputs ?? [source(), source()]
  const boundaryEvent = options.event === undefined ? (phase === "marker" ? null : startEvent) : options.event
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let sourceReads = 0
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('SELECT "input" FROM "agent_turns"')) {
      const input = inputs[Math.min(sourceReads++, inputs.length - 1)]
      return { rows: [{ input }], rowCount: 1 }
    }
    if (sql.includes('FROM "application_tasks"')) return { rows: [{ status: "filling", checkpoint: options.taskCheckpoint ?? (phase === "marker" ? "browser_active" : "submission_request_started"), workerTaskId: options.taskWorkerTaskId ?? scope.workerTaskId }], rowCount: 1 }
    if (sql.includes('FROM "submission_attempt"')) return { rows: options.attempt === null ? [] : [options.attempt ?? attempt], rowCount: options.attempt === null ? 0 : 1 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: options.approval === null ? [] : [options.approval ?? approval], rowCount: options.approval === null ? 0 : 1 }
    if (sql.includes('FROM "application_task_events"')) {
      const event = boundaryEvent && (!sql.includes("data\"->>'approvalId'") || (boundaryEvent as Record<string, unknown>).approvalId === values?.[1])
        ? boundaryEvent : null
      return { rows: event === null ? [] : [{ data: event }], rowCount: event === null ? 0 : 1 }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const client = { query } as never
  return { client, calls }
}

function resetMocks() {
  mocks.withExactAttemptFence.mockReset().mockImplementation(async (_client: unknown, _scope: unknown, work: () => Promise<unknown>) => ({
    kind: "current", value: await work(),
  }))
  mocks.acquireSourceMaterialFence.mockReset().mockResolvedValue(undefined)
  mocks.hasReviewedSubmissionArtifact.mockReset().mockResolvedValue(false)
  mocks.readReviewedApplicationSubmitMaterial.mockReset().mockResolvedValue({ artifactHash: resourceHash })
  mocks.hasObjectiveSubmissionManifestEvidence.mockReset().mockResolvedValue(false)
  mocks.readObjectiveReviewedApplicationSubmitMaterial.mockReset().mockResolvedValue({ artifactHash: resourceHash, objectiveSource })
}

describe("reviewed application submit request source fence", () => {
  it("locks source material before exact attempt rows and validates the consumed receipt and live reviewed proof", async () => {
    resetMocks()
    const { client, calls } = fixture()

    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "marker", undefined, async sourceTurnId => sourceTurnId)).resolves.toEqual({
      kind: "current", value: "source-turn-1", sourceTurnId: "source-turn-1",
    })

    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(client, [scope.userId])
    expect(mocks.acquireSourceMaterialFence.mock.invocationCallOrder[0]).toBeLessThan(mocks.withExactAttemptFence.mock.invocationCallOrder[0]!)
    expect(mocks.readReviewedApplicationSubmitMaterial).toHaveBeenCalledWith({
      client, identity: scope, sourceTurnId: "source-turn-1",
      approval: { resourceHash, materialHash, answersHash }, currentSource: true,
    })
    expect(calls.find(call => call.sql.includes('FROM "submission_attempt"'))?.sql).toContain("FOR UPDATE")
    expect(calls.find(call => call.sql.includes('FROM "agent_approvals"'))?.sql).toContain("FOR UPDATE")
  })

  it("reacquires the source fence before exact locks at the paused request boundary", async () => {
    resetMocks()
    const { client } = fixture({ phase: "boundary" })

    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "boundary", "source-turn-1", async sourceTurnId => sourceTurnId))
      .resolves.toEqual({ kind: "current", value: "source-turn-1", sourceTurnId: "source-turn-1" })

    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(client, [scope.userId])
    expect(mocks.acquireSourceMaterialFence.mock.invocationCallOrder[0]).toBeLessThan(mocks.withExactAttemptFence.mock.invocationCallOrder[0]!)
    expect(mocks.readReviewedApplicationSubmitMaterial).toHaveBeenCalledWith(expect.objectContaining({ currentSource: true, sourceTurnId: "source-turn-1" }))
  })

  it("retains the valid legacy path when no reviewed selector exists", async () => {
    resetMocks()
    const { client } = fixture({ inputs: [{}, {}] })

    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "marker", undefined, async sourceTurnId => sourceTurnId ?? "legacy"))
      .resolves.toEqual({ kind: "current", value: "legacy", sourceTurnId: null })

    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(client, [scope.userId])
    expect(mocks.hasReviewedSubmissionArtifact).toHaveBeenCalledWith(client, scope)
    expect(mocks.hasObjectiveSubmissionManifestEvidence).toHaveBeenCalledWith(client, scope)
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("does not downgrade a missing selector when the exact task already has a reviewed manifest", async () => {
    resetMocks()
    mocks.hasReviewedSubmissionArtifact.mockResolvedValueOnce(true)
    const { client } = fixture({ inputs: [{}, {}] })

    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "marker", undefined, async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })

    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(client, [scope.userId])
    expect(mocks.hasReviewedSubmissionArtifact).toHaveBeenCalledWith(client, scope)
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("does not downgrade an absent selector when an Objective submission manifest exists", async () => {
    resetMocks()
    mocks.hasObjectiveSubmissionManifestEvidence.mockResolvedValueOnce(true)
    const { client } = fixture({ inputs: [{}, {}] })
    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "marker", undefined, async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })
    expect(mocks.hasObjectiveSubmissionManifestEvidence).toHaveBeenCalledWith(client, scope)
    expect(mocks.readObjectiveReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("rechecks the exact Objective marker with the same consumed approval at the marker", async () => {
    resetMocks()
    const { client } = fixture({ inputs: [objectiveTurnInput, objectiveTurnInput] })
    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "marker", undefined,
      async sourceTurnId => sourceTurnId ?? "objective")).resolves.toEqual({
      kind: "current", value: "objective", sourceTurnId: null, objectiveSource,
    })
    expect(mocks.readObjectiveReviewedApplicationSubmitMaterial).toHaveBeenCalledWith({
      client, identity: scope, turnInput: objectiveTurnInput,
      approval: { resourceHash, materialHash, answersHash }, phase: "marker",
    })
  })

  it("rejects Objective marker removal or swap before the request boundary", async () => {
    resetMocks()
    const swapped = { reviewedApplicationMaterialSource: { ...objectiveSource, materialProofHash: "1".repeat(64) } }
    const removed = fixture({ phase: "boundary", inputs: [objectiveTurnInput, {}] })
    await expect(withReviewedApplicationSubmitRequestFence(removed.client, scope, "boundary",
      { kind: "objective", source: objectiveSource }, async () => "sent")).resolves.toEqual({ kind: "invalid" })

    resetMocks()
    const changed = fixture({ phase: "boundary", inputs: [objectiveTurnInput, swapped] })
    await expect(withReviewedApplicationSubmitRequestFence(changed.client, scope, "boundary",
      { kind: "objective", source: objectiveSource }, async () => "sent")).resolves.toEqual({ kind: "invalid" })
    expect(mocks.readObjectiveReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("rejects current Objective material or approval drift at the paused boundary", async () => {
    resetMocks()
    mocks.readObjectiveReviewedApplicationSubmitMaterial.mockResolvedValueOnce(null)
    const { client } = fixture({ phase: "boundary", inputs: [objectiveTurnInput, objectiveTurnInput] })
    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "boundary",
      { kind: "objective", source: objectiveSource }, async () => "sent")).resolves.toEqual({ kind: "invalid" })
    expect(mocks.readObjectiveReviewedApplicationSubmitMaterial).toHaveBeenCalledWith({
      client, identity: scope, turnInput: objectiveTurnInput,
      approval: { resourceHash, materialHash, answersHash }, phase: "boundary",
    })
  })

  it("rejects a mismatched Objective manifest hash or selector proof", async () => {
    resetMocks()
    mocks.readObjectiveReviewedApplicationSubmitMaterial.mockResolvedValueOnce({ artifactHash: "0".repeat(64), objectiveSource })
    const wrongHash = fixture({ inputs: [objectiveTurnInput, objectiveTurnInput] })
    await expect(withReviewedApplicationSubmitRequestFence(wrongHash.client, scope, "marker", undefined, async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })

    resetMocks()
    mocks.readObjectiveReviewedApplicationSubmitMaterial.mockResolvedValueOnce({
      artifactHash: resourceHash, objectiveSource: { ...objectiveSource, materialProofHash: "1".repeat(64) },
    })
    const wrongProof = fixture({ inputs: [objectiveTurnInput, objectiveTurnInput] })
    await expect(withReviewedApplicationSubmitRequestFence(wrongProof.client, scope, "marker", undefined, async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })
  })

  it("rejects a changed or removed selector rather than downgrading the reviewed request", async () => {
    resetMocks()
    const changed = fixture({ inputs: [source("source-turn-1"), source("source-turn-2")] })
    await expect(withReviewedApplicationSubmitRequestFence(changed.client, scope, "marker", undefined, async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()

    resetMocks()
    const missingAtBoundary = fixture({ phase: "boundary", inputs: [{}, {}] })
    await expect(withReviewedApplicationSubmitRequestFence(missingAtBoundary.client, scope, "boundary", "source-turn-1", async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })
    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(missingAtBoundary.client, [scope.userId])
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()

    resetMocks()
    mocks.withExactAttemptFence.mockResolvedValueOnce({ kind: "superseded" })
    const removedBeforeLock = fixture({ phase: "boundary", inputs: [{}, {}] })
    await expect(withReviewedApplicationSubmitRequestFence(removedBeforeLock.client, scope, "boundary", "source-turn-1", async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })
  })

  it.each([
    ["wrong task checkpoint", { taskCheckpoint: "submission_uncertain" }, "marker" as const],
    ["current Worker task changed", { taskWorkerTaskId: "other-worker" }, "marker" as const],
    ["request boundary Worker task changed", { taskWorkerTaskId: "other-worker" }, "boundary" as const],
    ["missing reserved attempt", { attempt: null }, "marker" as const],
    ["attempt artifact differs from the consumed approval", { attempt: { ...attempt, artifactHash: "e".repeat(64) } }, "marker" as const],
    ["approval was not consumed", { approval: { ...approval, status: "approved" } }, "marker" as const],
    ["boundary event names another worker task", { event: { ...startEvent, workerTaskId: "other-worker" } }, "boundary" as const],
  ])("rejects %s", async (_name, overrides, phase) => {
    resetMocks()
    const test = fixture({ ...overrides, phase })
    await expect(withReviewedApplicationSubmitRequestFence(
      test.client, scope, phase, phase === "boundary" ? "source-turn-1" : undefined, async () => "sent",
    )).resolves.toEqual({ kind: "invalid" })
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("rejects a live material proof mismatch or selector change at the request boundary", async () => {
    resetMocks()
    mocks.readReviewedApplicationSubmitMaterial.mockResolvedValueOnce(null)
    const invalidProof = fixture({ phase: "boundary" })
    await expect(withReviewedApplicationSubmitRequestFence(invalidProof.client, scope, "boundary", "source-turn-1", async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })

    resetMocks()
    const changed = fixture({ phase: "boundary", inputs: [source("source-turn-1"), source("source-turn-2")] })
    await expect(withReviewedApplicationSubmitRequestFence(changed.client, scope, "boundary", "source-turn-1", async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })
  })

  it("ignores start history belonging to another consumed approval", async () => {
    resetMocks()
    const test = fixture({ event: { ...startEvent, approvalId: "prior-approval" } })

    await expect(withReviewedApplicationSubmitRequestFence(test.client, scope, "marker", undefined, async sourceTurnId => sourceTurnId))
      .resolves.toEqual({ kind: "current", value: "source-turn-1", sourceTurnId: "source-turn-1" })

    const starts = test.calls.find(call => call.sql.includes('FROM "application_task_events"'))
    expect(starts?.sql).toContain("data\"->>'approvalId'=$2")
    expect(starts?.values).toEqual([scope.applicationTaskId, scope.approvalId])
  })
})
