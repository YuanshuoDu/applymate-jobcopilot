import { describe, expect, it } from "vitest"
import { parseTaskGraphSupersededScoutRetirementReceipt, taskGraphScoutRetirementIdempotencyKey,
  taskGraphScoutRetirementIdempotencyKeyFromIdentity,
  TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION, type TaskGraphScoutRetirementInput } from "./task-graph-scout-retirement-contract.js"

const input: TaskGraphScoutRetirementInput = { scope: { userId: "user", sessionId: "session", turnId: "turn",
  rootTaskId: "root", parentTaskId: "root", stepId: "step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1,
  parentLeaseOwner: "root-owner", parentAttemptCount: 1 }, expectedRevision: 4, taskId: "task-old", callId: "call-1" }
const receipt = { schemaVersion: TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION, sessionId: "session", turnId: "turn",
  rootTaskId: "root", nodeKey: "scout-old", taskId: "task-old", attempt: 2, interruptRequestedAt: "2026-01-01T00:00:00.000Z",
  graphRevision: 4, acceptedPlanRevision: 3, acceptedSteerSequence: "20", reconciliationStepId: "prior-step", reconciliationThroughSequence: "20",
  reconciliationEventId: "reconcile-event", reconciliationEventSequence: "32", reconciliationIdempotencyKey: `agent.plan.reconciliation:sha256:${"a".repeat(64)}`,
  planEventId: "plan-event", planEventSequence: "31", planIdempotencyKey: `task-graph-${"b".repeat(64)}:proposal:2`,
  replacementNodeKey: "scout-new", replacementTaskId: "task-new", replacementSourceSequence: "20" }

describe("superseded Scout retirement contract", () => {
  it("binds an exact action to one owner scope and target", () => {
    expect(taskGraphScoutRetirementIdempotencyKey(input)).toMatch(/^task_graph\.scout_retirement:sha256:[0-9a-f]{64}$/u)
    expect(taskGraphScoutRetirementIdempotencyKey({ ...input, expectedRevision: 3 })).not.toBe(taskGraphScoutRetirementIdempotencyKey(input))
    expect(taskGraphScoutRetirementIdempotencyKey({ ...input, taskId: "other" })).not.toBe(taskGraphScoutRetirementIdempotencyKey(input))
    expect(taskGraphScoutRetirementIdempotencyKey({ ...input, scope: { ...input.scope, rootTaskId: "other" } })).toBeNull()
  })

  it("recomputes the same key from stable persisted identity without lease fields", () => {
    const { userId, sessionId, turnId, rootTaskId, stepId } = input.scope
    expect(taskGraphScoutRetirementIdempotencyKeyFromIdentity({ scope: { userId, sessionId, turnId, rootTaskId, stepId },
      expectedRevision: input.expectedRevision, taskId: input.taskId, callId: input.callId }))
      .toBe(taskGraphScoutRetirementIdempotencyKey(input))
  })

  it("accepts exact private receipt fields and checks temporal binding", () => {
    expect(parseTaskGraphSupersededScoutRetirementReceipt(receipt, { sessionId: "session", taskId: "task-old" })).toEqual(receipt)
    expect(parseTaskGraphSupersededScoutRetirementReceipt({ ...receipt, replacementSourceSequence: "19" })).toBeNull()
    expect(parseTaskGraphSupersededScoutRetirementReceipt({ ...receipt, reconciliationEventSequence: "30" })).toBeNull()
    expect(parseTaskGraphSupersededScoutRetirementReceipt({ ...receipt, unexpected: true })).toBeNull()
  })
})
