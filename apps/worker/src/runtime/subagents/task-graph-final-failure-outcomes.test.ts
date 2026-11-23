import { describe, expect, it, vi } from "vitest"
import type { TaskGraphCurrentNode, TaskGraphCurrentState } from "./task-graph-command-port.js"
import { reduceTaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { TaskGraphFinalSummaryBinding, TaskGraphFinalSummaryMember } from "./task-graph-final-summary-binding.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import {
  buildFinalExecutionFailureOutcomes, readFinalExecutionFailureOutcomes,
} from "./task-graph-final-failure-outcomes.js"

const mocks = vi.hoisted(() => ({ current: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ currentTaskGraph: mocks.current }))

const graphRevision = 7
const category = "execution_setup_unavailable" as const

function failedSummary(taskId = "task-a", role = "scout") {
  return reduceTaskGraphFinalSummary({ graphRevision, nodes: [{ kind: "business", taskId, role, taskStatus: "failed" }] })
}

function member(taskId = "task-a", overrides: Partial<TaskGraphFinalSummaryMember> = {}): TaskGraphFinalSummaryMember {
  return { nodeIndex: 0, nodeKey: "node-a", templateId: "scout", taskId, role: "scout", taskType: "scout", taskStatus: "failed", kind: "business", ...overrides }
}

function failedNode(overrides: Partial<TaskGraphCurrentNode> = {}): TaskGraphCurrentNode {
  return { key: "node-a", templateId: "scout", goal: "goal", successCriteria: [], dependsOn: [], taskId: "task-a",
    status: "failed", readiness: "terminal", resultSummary: null, failureReason: "child_turn_missing", ...overrides }
}

function current(nodes: readonly TaskGraphCurrentNode[], revision = graphRevision): TaskGraphCurrentState {
  return { revision, nodes }
}

function project(nodes: readonly TaskGraphCurrentNode[], members: readonly TaskGraphFinalSummaryMember[], summary = failedSummary(), revision = graphRevision) {
  mocks.current.mockReturnValue(current(nodes, revision))
  return buildFinalExecutionFailureOutcomes({} as LoadedGraph, members, summary)
}

function privateBinding(overrides: Partial<TaskGraphFinalSummaryBinding> = {}): TaskGraphFinalSummaryBinding {
  const summary = failedSummary()
  return { rootTaskId: "root-task", graphItemId: "graph-item", graphRevision,
    members: [member()], summary, executionFailureOutcomes: [{ taskId: "task-a", category }], ...overrides }
}

describe("TaskGraph final failure outcomes", () => {
  it("projects only exact failed business members from the current graph", () => {
    const summary = failedSummary()
    expect(project([failedNode()], [member()], summary)).toEqual([
      { taskId: "task-a", category },
    ])
    expect(project([failedNode()], [member()], summary, graphRevision + 1)).toBeUndefined()
    expect(project([failedNode({ taskId: "foreign-task" })], [member()], summary)).toBeUndefined()
    expect(project([failedNode()], [member("task-a", { kind: "internal_control" })], summary)).toBeUndefined()
    expect(project([failedNode()], [member("task-a", { taskStatus: "completed" })], summary)).toBeUndefined()
    expect(project([failedNode()], [member("task-a", { templateId: "cover_letter_writer_slot_1" })], summary)).toBeUndefined()
  })

  it("passes a current projection from the producer into the closed reader", () => {
    mocks.current.mockReturnValue(current([failedNode()]))
    const summary = failedSummary()
    const outcomes = buildFinalExecutionFailureOutcomes({} as LoadedGraph, [member()], summary)
    const binding = privateBinding({ executionFailureOutcomes: outcomes })

    expect(outcomes).toEqual([{ taskId: "task-a", category }])
    expect([...readFinalExecutionFailureOutcomes(binding)]).toEqual([["task-a", category]])
    expect(JSON.stringify(binding)).not.toContain("child_turn_missing")
  })

  it("omits the optional projection when the current graph cannot be read", () => {
    mocks.current.mockImplementation(() => { throw new Error("private current graph failure") })
    expect(buildFinalExecutionFailureOutcomes({} as LoadedGraph, [member()], failedSummary())).toBeUndefined()
  })

  it("does not expose unknown, native, or reported failures", () => {
    const summary = failedSummary()
    expect(project([failedNode({ failureReason: "provider secret" })], [member()], summary)).toBeUndefined()
    expect(project([failedNode({ native: { operationId: "native" } as never })], [member()], summary)).toBeUndefined()
    expect(project([failedNode({
      verificationReport: { status: "failed" } as never,
    })], [member()], summary)).toBeUndefined()
    const projected = project([failedNode()], [member()], summary)
    expect(JSON.stringify(projected)).not.toContain("child_turn_missing")
  })

  it("retains only the canonical unverified resume and deadline exceptions", () => {
    const report = { status: "unverified", reasonCode: "result_invalid", criteria: [
      { criterionId: "candidate-count", status: "unverified", reasonCode: "result_invalid" },
    ], evidenceDigest: null, resultDigest: null }
    const resumeNode = failedNode({ failureReason: "child_resume_unavailable", templateId: "scout", verificationCriterionIds: ["candidate-count"],
      verification: { role: "scout", criteria: [{ id: "candidate-count" }] } as never, verificationReport: report as never })
    const resumeMember = member("task-a", { templateId: "scout" })
    expect(project([resumeNode], [resumeMember], failedSummary())).toEqual([
      { taskId: "task-a", category: "resume_state_unavailable" },
    ])
    const deadlineNode = failedNode({ failureReason: "task_graph_child_deadline_exceeded", verificationReport: report as never })
    expect(project([deadlineNode], [member()], failedSummary())).toEqual([
      { taskId: "task-a", category: "execution_deadline_exceeded" },
    ])
    expect(project([resumeNode], [member("task-a", { templateId: "analyst" })], failedSummary())).toBeUndefined()
  })

  it("reads only a closed, sorted, unique projection bound to failed business outcomes", () => {
    const binding = privateBinding()
    expect([...readFinalExecutionFailureOutcomes(binding)]).toEqual([["task-a", category]])
    expect(readFinalExecutionFailureOutcomes({ ...binding, executionFailureOutcomes: undefined }).size).toBe(0)
    expect(readFinalExecutionFailureOutcomes({ ...binding, executionFailureOutcomes: [{ taskId: "foreign", category }] }).size).toBe(0)
    expect(readFinalExecutionFailureOutcomes({ ...binding, executionFailureOutcomes: [{ taskId: "task-a", category: "raw failure" }] }).size).toBe(0)
    expect(readFinalExecutionFailureOutcomes({ ...binding, executionFailureOutcomes: [{ taskId: "task-a", category, failureReason: "secret" }] }).size).toBe(0)
    expect(readFinalExecutionFailureOutcomes({ ...binding, executionFailureOutcomes: [
      { taskId: "task-a", category }, { taskId: "task-a", category },
    ] }).size).toBe(0)
    expect(readFinalExecutionFailureOutcomes({ ...binding, graphRevision: graphRevision + 1 }).size).toBe(0)
    expect(readFinalExecutionFailureOutcomes({ ...binding, members: [member("task-a", { templateId: "cover_letter_writer_slot_1" })] }).size).toBe(0)
    expect(readFinalExecutionFailureOutcomes({ ...binding, selectedJobBatchFinalOutcome: {} }).size).toBe(0)
  })

  it("requires an exact failed row in the core summary, including for legacy carriers", () => {
    const completed = reduceTaskGraphFinalSummary({ graphRevision, nodes: [{ kind: "business", taskId: "task-a", role: "scout", taskStatus: "completed" }] })
    const mismatch = { ...privateBinding(), summary: completed }
    expect(readFinalExecutionFailureOutcomes(mismatch).size).toBe(0)
    expect(readFinalExecutionFailureOutcomes({ graphRevision, summary: failedSummary() }).size).toBe(0)
  })
})
