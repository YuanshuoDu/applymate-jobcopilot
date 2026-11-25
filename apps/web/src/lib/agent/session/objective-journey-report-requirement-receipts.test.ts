import { beforeEach, describe, expect, it, vi } from "vitest"
import { readObjectiveJourneyRequirementReceipts } from "./objective-journey-report-requirement-receipts"
import type { ObjectiveJourneySource } from "./objective-journey-report-source"

const mocks = vi.hoisted(() => ({ items: vi.fn(), events: vi.fn(), replay: vi.fn(), restore: vi.fn(), observations: vi.fn() }))
vi.mock("@jobcopilot/shared/task-graph-tool-receipt-verification", async importOriginal => {
  const actual = await importOriginal<typeof import("@jobcopilot/shared/task-graph-tool-receipt-verification")>()
  return { ...actual, validateTaskGraphVerificationItems: mocks.items, validateTaskGraphToolEvents: mocks.events,
    validateTaskGraphReplaySources: mocks.replay, restoreToolCallState: mocks.restore }
})
vi.mock("@jobcopilot/shared/task-graph-read-observations", async importOriginal => {
  const actual = await importOriginal<typeof import("@jobcopilot/shared/task-graph-read-observations")>()
  return { ...actual, canonicalTaskGraphReadObservations: mocks.observations }
})

const scope = { userId: "owner-1", sessionId: "session-1", sourceTurnId: "source-turn", rootTaskId: "source-root", graphRevision: 9,
  finalItemId: "final-item", sourceCounts: { discoveredJobs: { knownCount: 1, coverage: "complete" as const }, analyzedJobs: { knownCount: 1, coverage: "complete" as const } }, slots: [] }
const analyst = { nodeKey: "analyst-1", taskId: "analyst-task", attemptCount: 2, proofDigest: "a".repeat(64),
  jobMaterialDigest: `sha256:${"b".repeat(64)}`, criteriaIds: ["finding-count"], dependencyNodeKeys: ["scout-1"],
  dependencies: [{ nodeKey: "scout-1", taskId: "scout-task" }] }
const slot = { ordinal: 1, tailoringStatus: "ready" as const, sourceReady: true, jobId: "job-1", job: { company: "Example", role: "Engineer" },
  writerTaskId: "writer-1", reviewerTaskId: "reviewer-1", requirementAnalyst: analyst }
const task = { id: analyst.taskId, sessionId: scope.sessionId, turnId: scope.sourceTurnId, rootTaskId: scope.rootTaskId,
  parentTaskId: scope.rootTaskId, role: "analyst", taskType: "job_analysis", status: "completed", attemptCount: 2,
  failureReason: null, leaseOwner: null, leaseExpiresAt: null, result: { status: "completed" },
  expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "analyst" },
  allowedActions: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"] }
const job = { id: slot.jobId, userId: scope.userId, company: "Example", description: "Role description", keywords: null,
  location: null, role: "Engineer", salary: null, score: 8, source: "greenhouse", status: "saved", url: null }
type TestRow = Record<string, unknown>

describe("readObjectiveJourneyRequirementReceipts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.items.mockImplementation((values: readonly unknown[]) => values)
    mocks.events.mockReturnValue({ outcomes: new Map([["call-1", "completed"]]), replays: [] })
    mocks.replay.mockReturnValue([])
    mocks.restore.mockReturnValue({ observations: [], pending: [] })
    mocks.observations.mockReturnValue([{ id: "tool-result:call-1", content: { toolCallId: "call-1" } }])
  })

  it("loads current-attempt receipts only under exact owner, session, source Turn and root scope", async () => {
    const tx = fixtureTx()
    const result = await readObjectiveJourneyRequirementReceipts(tx as never, scope as ObjectiveJourneySource, slot)
    expect(result?.scope).toEqual({ userId: scope.userId, sessionId: scope.sessionId, turnId: scope.sourceTurnId,
      rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId, taskId: analyst.taskId, attemptCount: analyst.attemptCount })
    expect(tx.subAgentTask.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: analyst.taskId, sessionId: scope.sessionId, turnId: scope.sourceTurnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.rootTaskId, attemptCount: analyst.attemptCount, session: { is: { userId: scope.userId } },
    }) }))
    expect(tx.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: slot.jobId, userId: scope.userId } }))
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    const values = (tx.$queryRaw.mock.calls[0]?.[0] as unknown as { values?: unknown[] } | undefined)?.values
    expect(values).toEqual(expect.arrayContaining([analyst.taskId, scope.sessionId, scope.sourceTurnId, scope.rootTaskId, scope.userId]))
    expect(mocks.restore).toHaveBeenCalledWith(expect.any(Array), expect.any(Array))
  })

  it("returns no receipt when source or owner-bound Analyst is unavailable", async () => {
    const tx = fixtureTx()
    await expect(readObjectiveJourneyRequirementReceipts(tx as never, scope as ObjectiveJourneySource,
      { ...slot, sourceReady: false })).resolves.toBeNull()
    expect(tx.subAgentTask.findMany).not.toHaveBeenCalled()
    tx.subAgentTask.findMany.mockResolvedValueOnce([])
    await expect(readObjectiveJourneyRequirementReceipts(tx as never, scope as ObjectiveJourneySource, slot)).resolves.toBeNull()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it("loads replay source rows and lifecycle under the same exact owner scope", async () => {
    const tx = fixtureTx(), proof = { currentCallId: "replay-call", source: { toolCallId: "old-call", resultItemId: "old-result" } }
    mocks.events.mockReturnValue({ outcomes: new Map([["call-1", "completed"]]), replays: [proof] })
    mocks.replay.mockReturnValue([{ currentCallId: "replay-call", sourceCallItem: ["old-call-item", 1], sourceResultItem: ["old-result", 1] }])
    tx.$queryRaw.mockImplementation(async () => {
      const index = tx.$queryRaw.mock.calls.length
      return index === 1 ? tx.rows : index === 3 ? [{ sourceCallItemId: "old-call-item" }] : []
    })
    const result = await readObjectiveJourneyRequirementReceipts(tx as never, scope as ObjectiveJourneySource, slot)
    expect(result?.replayReceipts).toHaveLength(1)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4)
    expect(mocks.replay).toHaveBeenCalledWith([proof], [{ sourceCallItemId: "old-call-item" }], [], expect.any(Array), expect.objectContaining({ userId: scope.userId }))
  })
})

function fixtureTx() {
  const call = { id: "call-item", sessionId: scope.sessionId, turnId: scope.sourceTurnId, taskId: analyst.taskId,
    stepId: "step-1", type: "tool_call", status: "completed", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.get" },
    joinedStepId: "step-1", stepStatus: "completed", attempt: 2, ordinal: 0, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId }
  const result = { ...call, id: "result-item", type: "tool_result", content: { toolCallId: "call-1", output: { job } } }
  const queryRaw = vi.fn(async (..._args: unknown[]): Promise<TestRow[]> => [call, result])
  return { $queryRaw: queryRaw, rows: [call, result] as TestRow[], subAgentTask: { findMany: vi.fn(async () => [task]) }, job: { findMany: vi.fn(async () => [job]) } }
}
