import { beforeEach, describe, expect, it, vi } from "vitest"
import { readSteeringReconciliationState } from "../subagents/steering-reconciliation-read.js"
import { appendTaskGraphReceipt } from "../subagents/task-graph-pg-events.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { questionId, questionItemId, type TurnQuestionQueryClient } from "./turn-question-store-guards.js"
import { appendTurnQuestionPlanningObservation, prepareTurnQuestionPlanningObservation } from "./turn-question-planning-store.js"

vi.mock("../subagents/steering-reconciliation-read.js", () => ({ readSteeringReconciliationState: vi.fn() }))
vi.mock("../subagents/task-graph-pg-events.js", () => ({ appendTaskGraphReceipt: vi.fn() }))

const owner: TurnExecutionOwnerFence = { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
  rootTaskId: "root-1", ownerId: "lease-1", leaseVersion: 4, leaseExpiresAt: new Date("2026-10-07T10:00:00Z") }
const stepId = "step-2", toolCallId = "call-3", waitId = questionId(owner, stepId, toolCallId)
const state = { originalInputId: "original", currentRevision: 5, decisionStepId: stepId, decisionStepOrdinal: 2, decisionStepAttempt: 2,
  decisionInputThroughSequence: 12n, agendaPlanRevision: 4, resolvedInputIds: [], unresolvedInputs: [
    { id: "steer-consumed", acceptedSequence: 8n, status: "consumed" as const, consumedByStepId: "step-1", consumingOrdinal: 1 },
    { id: "steer-new", acceptedSequence: 12n, status: "accepted" as const, consumedByStepId: null, consumingOrdinal: null },
  ] }

function client(actions: unknown = ["agent.plan"], confirmedActions: unknown = actions): { query: TurnQuestionQueryClient["query"]; order: string[]; statements: string[] } {
  const order: string[] = []
  const statements: string[] = []
  let rootReads = 0
  const query = vi.fn(async (sql: string) => {
    statements.push(sql)
    if (sql.includes('FROM "sub_agent_tasks"')) {
      rootReads += 1
      order.push(rootReads === 1 ? "root-policy" : "confirmed-policy")
      return { rows: [{ allowedActions: rootReads === 1 ? actions : confirmedActions, leaseOwner: owner.ownerId, attemptCount: 2 }], rowCount: 1 }
    }
    order.push("step")
    return { rows: [{ taskId: owner.rootTaskId, status: "streaming", attempt: 2, inputThroughSequence: "12",
      consumedInputIds: ["original", "steer-consumed"] }], rowCount: 1 }
  })
  return { query: query as unknown as TurnQuestionQueryClient["query"], order, statements }
}

beforeEach(() => { vi.clearAllMocks() })

describe("turn question planning observation store", () => {
  it("does not invoke the steering reader for a persisted nonplanning Root", async () => {
    const db = client([])
    await expect(prepareTurnQuestionPlanningObservation(db, { owner, stepId, toolCallId, waitId, questionItemId: questionItemId(waitId) })).resolves.toBeNull()
    expect(readSteeringReconciliationState).not.toHaveBeenCalled()
    expect(db.order).toEqual(["root-policy"])
    expect(db.statements[0]).not.toMatch(/FOR\s+UPDATE/i)
  })

  it("rechecks planning policy after taking the same-client reconciliation locks", async () => {
    const db = client(["agent.plan"], [])
    vi.mocked(readSteeringReconciliationState).mockImplementation(async (actualClient) => {
      expect(actualClient).toBe(db)
      db.order.push("ledger")
      return state
    })
    await expect(prepareTurnQuestionPlanningObservation(db, { owner, stepId, toolCallId, waitId, questionItemId: questionItemId(waitId) })).resolves.toBeNull()
    expect(db.order).toEqual(["root-policy", "ledger", "confirmed-policy"])
  })

  it("captures same-Step revisions, the complete unresolved set, and the exact locked checkpoint", async () => {
    const db = client()
    vi.mocked(readSteeringReconciliationState).mockImplementation(async (actualClient, scope) => {
      expect(actualClient).toBe(db)
      expect(scope).toMatchObject({ userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
        rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, stepId, parentAttemptCount: 2 })
      expect(scope).not.toHaveProperty("rootInputId")
      db.order.push("ledger")
      return state
    })
    const receipt = await prepareTurnQuestionPlanningObservation(db, { owner, stepId, toolCallId, waitId, questionItemId: questionItemId(waitId) })
    expect(db.order).toEqual(["root-policy", "ledger", "confirmed-policy", "step"])
    expect(db.statements.filter(statement => statement.includes('FROM "sub_agent_tasks"')).every(statement => !/FOR\s+UPDATE/i.test(statement))).toBe(true)
    expect(db.statements.at(-1)).toMatch(/FOR\s+UPDATE/i)
    expect(receipt).toMatchObject({ observedPlanRevision: 4, graphRevisionAtAsk: 5,
      pendingSteers: [
        { id: "steer-consumed", acceptedSequence: "8", status: "consumed", consumedByStepId: "step-1", consumingOrdinal: 1 },
        { id: "steer-new", acceptedSequence: "12", status: "accepted", consumedByStepId: null, consumingOrdinal: null },
      ], inputCheckpoint: { throughSequence: "12", consumedInputIds: ["original", "steer-consumed"] } })
  })

  it("fails closed when the locked Step checkpoint differs from the reader's checkpoint", async () => {
    const db = client()
    vi.mocked(readSteeringReconciliationState).mockResolvedValue({ ...state, decisionInputThroughSequence: 11n })
    await expect(prepareTurnQuestionPlanningObservation(db, { owner, stepId, toolCallId, waitId, questionItemId: questionItemId(waitId) }))
      .rejects.toThrow("question_planning_checkpoint_invalid")
  })

  it("writes the private receipt on the supplied tenant without adding userId to its payload", async () => {
    const receipt = {
      schemaVersion: "agent-harness.v2.plan-clarification.v1" as const, sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
      stepId, toolCallId, waitId, questionItemId: questionItemId(waitId), observedPlanRevision: 4, graphRevisionAtAsk: 5,
      pendingSteers: [], inputCheckpoint: { throughSequence: "12", consumedInputIds: ["original"] },
    }
    await appendTurnQuestionPlanningObservation({ query: vi.fn() } as unknown as TurnQuestionQueryClient, receipt, owner.userId)
    const [clientArg, input] = vi.mocked(appendTaskGraphReceipt).mock.calls[0]!
    expect(input).toMatchObject({ scope: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, stepId }, itemId: null,
      type: "agent.plan.clarification", actor: "orchestrator", outbox: false,
      idempotencyKey: `turn:${owner.turnId}:event:planning-clarification:${waitId}` })
    expect(input.payload).toEqual(receipt)
    expect(input.payload).not.toHaveProperty("userId")
    expect(clientArg).toBeDefined()
  })
})
