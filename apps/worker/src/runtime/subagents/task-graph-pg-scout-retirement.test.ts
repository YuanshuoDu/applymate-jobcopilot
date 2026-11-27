import { beforeEach, describe, expect, it, vi } from "vitest"
import { requestSupersededScoutRetirement } from "./task-graph-pg-scout-retirement.js"
import { taskGraphScoutRetirementIdempotencyKey, TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE,
  TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION, type TaskGraphScoutRetirementInput,
  type TaskGraphSupersededScoutRetirementReceipt } from "./task-graph-scout-retirement-contract.js"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import type { PgSubagentPool } from "./types.js"

const mocks = vi.hoisted(() => ({ lock: vi.fn(), load: vi.fn(), reconcile: vi.fn(), confirmed: vi.fn(), plan: vi.fn(), interrupt: vi.fn(), receipt: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ lockTaskGraphScope: mocks.lock, loadTaskGraph: mocks.load }))
vi.mock("./steering-reconciliation-read.js", () => ({ readSteeringReconciliationState: mocks.reconcile }))
vi.mock("./task-graph-confirmed-location-steer.js", () => ({ readTaskGraphConfirmedLocationSteer: mocks.confirmed }))
vi.mock("./task-graph-pg-scout-retirement-plan.js", () => ({ buildTaskGraphSupersededScoutRetirementPlan: mocks.plan }))
vi.mock("./task-interrupt-outbox.js", () => ({ appendInternalAcceptedInterrupt: mocks.interrupt }))
vi.mock("./task-graph-pg-events.js", () => ({ appendTaskGraphReceiptWithIdentity: mocks.receipt }))

type QueryCall = { sql: string; values: readonly unknown[] }
const input: TaskGraphScoutRetirementInput = { scope: { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root",
  parentTaskId: "root", stepId: "step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1,
  parentLeaseOwner: "root-owner", parentAttemptCount: 1 }, expectedRevision: 4, taskId: "task-old", callId: "call-1" }
const plan = { schemaVersion: TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION, sessionId: "session", turnId: "turn", rootTaskId: "root",
  nodeKey: "scout-old", taskId: "task-old", graphRevision: 4, acceptedPlanRevision: 3, acceptedSteerSequence: "20", reconciliationStepId: "prior-step",
  reconciliationThroughSequence: "20", reconciliationEventId: "reconcile-event", reconciliationEventSequence: "32",
  reconciliationIdempotencyKey: `agent.plan.reconciliation:sha256:${"a".repeat(64)}`, planEventId: "plan-event", planEventSequence: "31",
  planIdempotencyKey: `task-graph-${"b".repeat(64)}:proposal:2`, replacementNodeKey: "scout-new", replacementTaskId: "task-new",
  replacementSourceSequence: "20" }
const receipt: TaskGraphSupersededScoutRetirementReceipt = { ...plan, attempt: 2, interruptRequestedAt: "2026-01-01T00:00:00.000Z" }

function fakePool(prior = false) {
  const calls: QueryCall[] = []
  const client = { query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values })
    if (sql.includes("event.\"idempotencyKey\" = $3") && sql.includes("agent_outbox")) return prior
      ? { rows: [{ id: "retirement-event", type: TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE, actor: "system",
        itemId: taskGraphItemId("root"), taskId: "task-old", correlationId: "turn", causationId: "step",
        idempotencyKey: taskGraphScoutRetirementIdempotencyKey(input), payload: receipt, hasOutbox: false }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
    if (typeof values[3] === "string" && values[3].startsWith("agent-task-interrupt:")) return { rows: [{ id: "interrupt-event", type: "task.interrupt.accepted", actor: "system",
      taskId: "task-old", idempotencyKey: values[3], payload: { status: "accepted", taskId: "task-old" } }], rowCount: 1 }
    if (sql.includes("WITH live AS MATERIALIZED")) return { rows: [{ id: "task-old", parentTaskId: "root", rootTaskId: "root", status: "running",
      role: "scout", taskType: "job_discovery", attemptCount: 2, leaseOwner: "child-owner", interruptRequestedAt: null,
      failureReason: null, leaseValid: true, hasChild: false }], rowCount: 1 }
    if (sql.startsWith("UPDATE \"sub_agent_tasks\"")) return { rows: [{ interruptRequestedAt: new Date("2026-01-01T00:00:00.000Z"), attemptCount: 2 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }), release: vi.fn() }
  return { calls, client, pool: { connect: vi.fn(async () => client) } as unknown as PgSubagentPool }
}

describe("private superseded Scout retirement writer", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.load.mockResolvedValue({ item: { revision: 4 }, tasks: new Map([["task-old", { id: "task-old", status: "running", role: "scout",
      taskType: "job_discovery", attemptCount: 2, failureReason: null }]]) })
    mocks.reconcile.mockResolvedValue({ decisionInputThroughSequence: 20n })
    mocks.confirmed.mockResolvedValue({ kind: "confirmed", locations: ["dublin"], acceptedInputSequence: 20n })
    mocks.plan.mockResolvedValue(plan)
    mocks.receipt.mockResolvedValue({ id: "retirement-event", sequence: 40 })
  })

  it("records only an exact live target request and a private same-transaction receipt", async () => {
    const fake = fakePool()
    const result = await requestSupersededScoutRetirement(fake.pool, input)
    expect(result).toEqual({ status: "requested", taskId: "task-old", receiptEventId: "retirement-event", receipt })
    expect(mocks.lock).toHaveBeenCalledWith(expect.anything(), input.scope, true)
    expect(mocks.confirmed).toHaveBeenCalledWith(expect.anything(), {
      userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root",
    }, 20n)
    expect(mocks.interrupt).toHaveBeenCalledWith(expect.anything(), "user", expect.objectContaining({ taskId: "task-old", interruptRequestedAt: receipt.interruptRequestedAt }))
    expect(mocks.receipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ taskId: "task-old",
      type: TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE, actor: "system", idempotencyKey: taskGraphScoutRetirementIdempotencyKey(input), payload: receipt }))
    expect(mocks.receipt.mock.calls[0]?.[1]).not.toHaveProperty("outbox", true)
    expect(fake.calls.some(call => call.sql.startsWith("UPDATE \"agent_items\""))).toBe(false)
    expect(fake.calls.map(call => call.sql)).toContain("COMMIT")
  })

  it("replays the exact receipt without rewriting or implying worker acknowledgment", async () => {
    const fake = fakePool(true)
    await expect(requestSupersededScoutRetirement(fake.pool, input)).resolves.toMatchObject({ status: "duplicate", receipt, taskId: "task-old" })
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.interrupt).not.toHaveBeenCalled()
    expect(mocks.receipt).not.toHaveBeenCalled()
    expect(fake.calls.some(call => call.sql.startsWith("UPDATE \"sub_agent_tasks\""))).toBe(false)
  })

  it("fails closed before task mutation when accepted replacement proof is unavailable", async () => {
    const fake = fakePool()
    mocks.plan.mockResolvedValueOnce(null)
    await expect(requestSupersededScoutRetirement(fake.pool, input)).rejects.toMatchObject({ code: "task_graph_scout_retirement_unavailable" })
    expect(fake.calls.some(call => call.sql.startsWith("UPDATE \"sub_agent_tasks\""))).toBe(false)
    expect(mocks.interrupt).not.toHaveBeenCalled()
  })
})
