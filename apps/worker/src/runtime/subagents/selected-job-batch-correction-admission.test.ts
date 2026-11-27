import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { createSelectedJobBatchTemplateRegistry, pairSelectedJobBatchCorrectionProposal, type SelectedJobBatchSlot } from "./selected-job-batch-plan.js"
import { assertSelectedJobBatchPlanAdmission, SelectedJobBatchCorrectionAdmissionError } from "./selected-job-batch-correction-admission.js"
import type { TaskGraphState } from "../planning/task-graph.js"
import type { TaskGraphExecutionScope } from "./task-graph-schedule-input.js"

const mocks = vi.hoisted(() => ({ head: vi.fn(), receipt: vi.fn(), source: vi.fn() }))
vi.mock("../../db/agent-artifact-repo.js", () => ({
  findCurrentDraftHeadWithClient: mocks.head, findReviewReceiptWithClient: mocks.receipt,
}))
vi.mock("./selected-job-artifact-context.js", () => ({ readSelectedJobSourceDigestWithClient: mocks.source }))

const slots: readonly SelectedJobBatchSlot[] = [
  { slotId: "slot-1", jobId: "job-a" }, { slotId: "slot-2", jobId: "job-b" },
]
const templates = createSelectedJobBatchTemplateRegistry(slots, {
  writer: { role: "writer", taskType: "cover_letter_draft", allowedActions: ["cover_letter.draft"] },
  reviewer: { role: "reviewer", taskType: "cover_letter_review", allowedActions: ["artifact.review"] },
}).templates
const digest = `sha256:${"a".repeat(64)}`
const ref = { artifactId: "draft-a", version: 2, contentHash: digest, sourceDigest: digest }
const scope: TaskGraphExecutionScope = {
  userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", parentTaskId: "root-a",
  stepId: "step-a", turnLeaseOwner: "turn-owner", turnLeaseVersion: 4, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}
const artifactVersionResult = (value = ref) => ({ schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef: value })
const reviewResult = (value = ref, reviewStatus: "needs_revision" | "passed" = "needs_revision") => ({
  schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef: value,
  reviewStatus, reviewHash: digest,
})
const envelope = (structuredResult: unknown) => ({
  finalItemId: "final-private", finalText: "private output", status: "completed", stepCount: 1, toolCallCount: 1, structuredResult,
})

function node(key: string, templateId: string, dependsOn: readonly string[], status: TaskGraphState["nodes"][number]["status"], taskId?: string) {
  return { key, templateId, dependsOn, goal: "Prepare", successCriteria: ["Review"], depth: dependsOn.length + 1,
    status, ...(taskId ? { taskId } : {}) }
}
function currentGraph(priorCorrection = false): TaskGraphState {
  const nodes = [
    node("writer-a", "cover_letter_writer_slot_1", [], "completed", "writer-task-a"),
    node("reviewer-a", "cover_letter_reviewer_slot_1", ["writer-a"], "completed", "reviewer-task-a"),
    node("writer-b", "cover_letter_writer_slot_2", [], "completed", "writer-task-b"),
    node("reviewer-b", "cover_letter_reviewer_slot_2", ["writer-b"], "completed", "reviewer-task-b"),
  ]
  if (priorCorrection) nodes.push(
    node("writer-a-v2", "cover_letter_writer_slot_1", ["reviewer-a"], "completed", "writer-task-a-v2"),
    node("reviewer-a-v2", "cover_letter_reviewer_slot_1", ["writer-a-v2"], "completed", "reviewer-task-a-v2"),
  )
  return { revision: priorCorrection ? 3 : 2, nodes, appliedEvents: [] }
}
function proposal(slot: "slot-1" | "slot-2" = "slot-1", predecessor?: string) {
  const suffix = slot === "slot-1" ? "a" : "b", writer = `writer-${suffix}-v2`
  return [
    node(writer, `cover_letter_writer_${slot.replace("slot-", "slot_")}`, [predecessor ?? `reviewer-${suffix}`], "queued"),
    node(`reviewer-${suffix}-v2`, `cover_letter_reviewer_${slot.replace("slot-", "slot_")}`,
      [writer], "waiting"),
  ]
}
function taskRows(jobId: string, suffix: "a" | "b", writerOverrides: Record<string, unknown> = {}, reviewerOverrides: Record<string, unknown> = {}) {
  const writerId = `writer-task-${suffix}`, reviewerId = `reviewer-task-${suffix}`
  return [
    { id: writerId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, role: "writer", taskType: "cover_letter_draft", status: "completed", failureReason: null,
      context: { selectedJobPreparation: { jobId } }, result: envelope(artifactVersionResult()), ...writerOverrides },
    { id: reviewerId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, role: "reviewer", taskType: "cover_letter_review", status: "completed", failureReason: null,
      context: { selectedJobPreparation: { jobId }, taskGraphDependencyResults: { items: [] } },
      result: envelope(reviewResult()), ...reviewerOverrides },
  ]
}
function fixture(options: Readonly<{
  slot?: "slot-1" | "slot-2"; current?: TaskGraphState; predecessor?: string; rows?: unknown[]; source?: string | null
}> = {}) {
  const selectedSlot = options.slot ?? "slot-1", suffix = selectedSlot === "slot-1" ? "a" : "b"
  const current = options.current ?? currentGraph()
  const added = proposal(selectedSlot, options.predecessor)
  const proposedState = { ...current, revision: current.revision + 1, nodes: [...current.nodes, ...added] }
  const tasks = options.rows ?? taskRows(selectedSlot === "slot-1" ? "job-a" : "job-b", suffix)
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: tasks }
    if (sql.includes('FROM "agent_artifact_version"')) return { rows: [{ taskId: `writer-task-${suffix}` }] }
    throw new Error("unexpected_query")
  })
  const corrections = pairSelectedJobBatchCorrectionProposal(added, slots)
  const input = {
    client: { query } as unknown as Pick<pg.PoolClient, "query">, scope, current, proposedState,
    proposedNodes: added, templates, priorTaskIds: new Map(current.nodes.map(item => [item.key, item.taskId!] as const)),
    hasReplacementMode: false, hasRootSuccessCriteria: false,
  }
  mocks.source.mockResolvedValue(options.source === undefined ? digest : options.source)
  mocks.head.mockResolvedValue(ref)
  mocks.receipt.mockImplementation(async (_client: unknown, receiptScope: Record<string, unknown>) => ({ ...receiptScope, toolCallId: "review-call" }))
  return { input, query, corrections }
}

describe("selected-job batch correction plan admission", () => {
  beforeEach(() => { mocks.head.mockReset(); mocks.receipt.mockReset(); mocks.source.mockReset() })

  it("admits exact initial batch setup without reading review evidence", async () => {
    const nodes = [
      node("writer-a", "cover_letter_writer_slot_1", [], "queued"),
      node("reviewer-a", "cover_letter_reviewer_slot_1", ["writer-a"], "waiting"),
      node("writer-b", "cover_letter_writer_slot_2", [], "queued"),
      node("reviewer-b", "cover_letter_reviewer_slot_2", ["writer-b"], "waiting"),
    ]
    const query = vi.fn(async () => { throw new Error("initial_plan_reads_no_child_receipts") })
    await expect(assertSelectedJobBatchPlanAdmission({
      client: { query } as unknown as Pick<pg.PoolClient, "query">, scope,
      current: { revision: 0, nodes: [], appliedEvents: [] },
      proposedState: { revision: 1, nodes, appliedEvents: [] }, proposedNodes: nodes,
      templates, priorTaskIds: new Map(), hasReplacementMode: false, hasRootSuccessCriteria: true,
    })).resolves.toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })

  it("admits a current needs_revision receipt and binds the original Writer artifact", async () => {
    const value = fixture()
    await expect(assertSelectedJobBatchPlanAdmission(value.input)).resolves.toBeUndefined()
    expect(value.query).toHaveBeenCalledTimes(2)
    expect(value.query.mock.calls[0]?.[1]).toEqual([
      ["writer-task-a", "reviewer-task-a"], scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId,
    ])
    expect(value.query.mock.calls[1]?.[1]).toEqual([scope.userId, scope.sessionId, "job-a", ref.artifactId, ref.version, ref.contentHash, ref.sourceDigest])
    expect(mocks.receipt).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ taskId: "reviewer-task-a", status: "needs_revision", reviewHash: digest }))
  })

  it("allows a different Job correction after another slot already has its one completed correction", async () => {
    const current = currentGraph(true), value = fixture({ slot: "slot-2", current })
    await expect(assertSelectedJobBatchPlanAdmission(value.input)).resolves.toBeUndefined()
    expect(value.query.mock.calls[0]?.[1]?.[0]).toEqual(["writer-task-b", "reviewer-task-b"])
    expect(mocks.head).toHaveBeenCalledWith(expect.anything(), { userId: scope.userId, sessionId: scope.sessionId, jobId: "job-b", artifactId: ref.artifactId })
  })

  it.each([
    ["foreign owner", taskRows("job-a", "a", {}, { userId: "other-user" })],
    ["wrong task type", taskRows("job-a", "a", {}, { taskType: "other" })],
    ["wrong Job context", taskRows("job-a", "a", {}, { context: { selectedJobPreparation: { jobId: "other-job" } } })],
    ["bare result instead of completed envelope", taskRows("job-a", "a", {}, { result: reviewResult() })],
    ["review did not request a correction", taskRows("job-a", "a", {}, { result: envelope(reviewResult(ref, "passed")) })],
    ["Writer and Reviewer disagree on immutable artifact", taskRows("job-a", "a", {}, { result: envelope(reviewResult({ ...ref, version: 1 })) })],
  ])("rejects %s", async (_name, rows) => {
    const value = fixture({ rows })
    await expect(assertSelectedJobBatchPlanAdmission(value.input)).rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)
  })

  it("rejects stale source, changed current draft, wrong authoring task, and absent private receipt", async () => {
    const staleSource = fixture({ source: `sha256:${"b".repeat(64)}` })
    await expect(assertSelectedJobBatchPlanAdmission(staleSource.input)).rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)
    expect(mocks.receipt).not.toHaveBeenCalled()

    const staleHead = fixture()
    mocks.head.mockResolvedValueOnce({ ...ref, version: ref.version + 1 })
    await expect(assertSelectedJobBatchPlanAdmission(staleHead.input)).rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)

    const wrongAuthor = fixture()
    wrongAuthor.query.mockImplementation(async (sql: string) => sql.includes('FROM "sub_agent_tasks" AS task')
      ? { rows: taskRows("job-a", "a") } : { rows: [{ taskId: "another-writer" }] })
    await expect(assertSelectedJobBatchPlanAdmission(wrongAuthor.input)).rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)

    const noReceipt = fixture()
    mocks.receipt.mockResolvedValueOnce(null)
    await expect(assertSelectedJobBatchPlanAdmission(noReceipt.input)).rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)
  })

  it("rejects cross-slot, repeated, mixed-mode, and malformed registry plans before receipt reads", async () => {
    const cross = fixture({ predecessor: "reviewer-b" })
    await expect(assertSelectedJobBatchPlanAdmission(cross.input)).rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)
    const repeatedCurrent = currentGraph(true), repeated = fixture({ current: repeatedCurrent })
    const repeatedNodes = proposal("slot-1", "reviewer-a-v2")
    await expect(assertSelectedJobBatchPlanAdmission({ ...repeated.input, proposedNodes: repeatedNodes,
      proposedState: { ...repeatedCurrent, revision: repeatedCurrent.revision + 1,
        nodes: [...repeatedCurrent.nodes, ...repeatedNodes] } })).rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)
    const replacement = fixture()
    await expect(assertSelectedJobBatchPlanAdmission({ ...replacement.input, hasReplacementMode: true }))
      .rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)
    await expect(assertSelectedJobBatchPlanAdmission({ ...replacement.input, hasRootSuccessCriteria: true }))
      .rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)
    const mixed = fixture()
    await expect(assertSelectedJobBatchPlanAdmission({ ...mixed.input,
      proposedState: { ...mixed.input.proposedState, nodes: [...mixed.input.proposedState.nodes,
        node("scout", "scout", [], "queued")] } })).rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)
    const malformedRegistry = fixture()
    await expect(assertSelectedJobBatchPlanAdmission({ ...malformedRegistry.input,
      templates: { ...templates, cover_letter_reviewer_slot_2: { role: "reviewer", taskType: "wrong", allowedActions: [] } } }))
      .rejects.toBeInstanceOf(SelectedJobBatchCorrectionAdmissionError)
  })
})
