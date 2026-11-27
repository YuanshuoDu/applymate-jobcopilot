import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.js"
import type { TaskGraphExecutionScope } from "./task-graph-schedule-input.js"
import { buildTaskGraphSupersededScoutRetirementPlan } from "./task-graph-pg-scout-retirement-plan.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-template-definitions.js"
import { taskGraphItemId, taskGraphProposalKey, taskGraphState, parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { steeringReconciliationIdempotencyKey, STEERING_RECONCILIATION_EVENT_TYPE,
  STEERING_RECONCILIATION_SCHEMA_VERSION } from "./steering-reconciliation-contract.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import type { PoolClient } from "pg"

const scope: TaskGraphExecutionScope = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root",
  stepId: "action-step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1 }
const oldCheck = { id: "candidate-location", check: { kind: "candidate_location_in" as const, locations: ["berlin"] } }
const currentCheck = { id: "candidate-location", check: { kind: "candidate_location_in" as const, locations: ["dublin"] } }
const verification = (location: typeof oldCheck) => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2,
  role: "scout" as const, criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }, location] })

function node(key: string, taskId: string, depth: number, check = oldCheck) {
  const template = TASK_GRAPH_TEMPLATES.scout
  return { key, taskId, templateId: "scout", goal: "Find jobs", successCriteria: ["Find verified jobs"], dependsOn: [], depth,
    verificationDisposition: "typed" as const, verification: verification(check), registeredScoutEnvelope: {
      role: template.role, taskType: template.taskType, expectedOutputSchema: template.expectedOutputSchema, allowedActions: template.allowedActions,
    } }
}

function fixtures(oldLocations: readonly string[] = ["berlin"]) {
  const oldNode = node("scout-old", "task-old", 1, { ...oldCheck, check: { kind: "candidate_location_in" as const, locations: [...oldLocations] } })
  const newNode = node("scout-new", "task-new", 1, currentCheck)
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [oldNode, newNode] })
  const tasks = new Map([
    ["task-old", { id: "task-old", status: "running" as const, role: "scout", taskType: "job_discovery", expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema,
      allowedActions: TASK_GRAPH_TEMPLATES.scout.allowedActions, contextIsObject: true, contextIsEmpty: true, contextIsCanonicalNestedScoutProfile: false,
      hasPrivateSelectionContext: false, attemptCount: 2, failureReason: null, result: null }],
    ["task-new", { id: "task-new", status: "queued" as const, role: "scout", taskType: "job_discovery", expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema,
      allowedActions: TASK_GRAPH_TEMPLATES.scout.allowedActions, contextIsObject: true, contextIsEmpty: true, contextIsCanonicalNestedScoutProfile: false,
      hasPrivateSelectionContext: false, attemptCount: 0, failureReason: null, result: null }],
  ])
  const state = taskGraphState(snapshot, 4, new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }])), [])
  const loaded: LoadedGraph = { rootTaskId: "root", snapshot, state, item: { id: taskGraphItemId("root"), revision: 4, content: snapshot, createdAt: new Date() },
    tasks, discoveryTurnEligibility: "ordinary", currentInputCheckpoint: { inputThroughSequence: 25n },
    sourceInputCheckpointByNodeKey: new Map([["scout-old", { inputThroughSequence: 8n }], ["scout-new", { inputThroughSequence: 20n }]]) }
  const planContent = snapshot
  const planEvent = { id: "plan-event", sequence: "31", type: "item.delta", actor: "orchestrator", itemId: taskGraphItemId("root"), taskId: "root",
    correlationId: "turn", causationId: "plan-step", idempotencyKey: taskGraphProposalKey("root", 2), payload: {
      kind: "proposal", fingerprint: "a".repeat(64), revision: 3, content: planContent,
      item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId("root"), sessionId: "session", turnId: "turn", stepId: "plan-step",
        taskId: "root", type: "task_graph", status: "streaming", phase: null, revision: 3, content: planContent,
        startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      receipt: { status: "accepted", revision: 3, nodes: [{ key: "scout-new", taskId: "task-new", status: "queued" }], readyTaskIds: ["task-new"] },
    } }
  const reconciliationReceipt = { schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: "session", turnId: "turn", rootTaskId: "root",
    stepId: "plan-step", decision: "revise", observedRevision: 2, resultingRevision: 3, steerInputIds: ["steer-input"], inputCheckpoint: { throughSequence: "20" } }
  const reconEvent = { id: "reconcile-event", sequence: "32", type: "agent.plan.reconciliation", actor: "orchestrator", itemId: null,
    taskId: "root", correlationId: "turn", causationId: "plan-step",
    idempotencyKey: steeringReconciliationIdempotencyKey({ ...scope, stepId: "plan-step" }, "plan-call"), payload: reconciliationReceipt, hasOutbox: false }
  const query = vi.fn(async (_sql: string, values?: readonly unknown[]) => values?.[2] === STEERING_RECONCILIATION_EVENT_TYPE
    ? { rows: [reconEvent] } : { rows: [planEvent] })
  const client = { query } as unknown as Pick<PoolClient, "query">
  const reconciliation = { originalInputId: "root-input", currentRevision: 4, decisionStepId: "action-step", decisionStepOrdinal: 3,
    decisionStepAttempt: 1, decisionInputThroughSequence: 25n, agendaPlanRevision: 4,
    latestUserRevision: { resultingRevision: 3, stepId: "plan-step", inputThroughSequence: 20n, soleSteerSequence: 20n },
    lastReconciledInputThroughSequence: 20n, unresolvedInputs: [] }
  const confirmed = { kind: "confirmed" as const, locations: ["dublin"], acceptedInputSequence: 20n, acceptedInputId: "steer-input" }
  const input = { client, scope, expectedRevision: 4, taskId: "task-old", callId: "retire-call", loaded, reconciliation, confirmed }
  return { input, client, query, loaded, planEvent }
}

describe("superseded Scout retirement plan", () => {
  it("rebinds a later action revision to the earlier accepted confirmed plan", async () => {
    const fixture = fixtures()
    const plan = await buildTaskGraphSupersededScoutRetirementPlan(fixture.input)
    expect(plan).toMatchObject({ graphRevision: 4, acceptedPlanRevision: 3, nodeKey: "scout-old", taskId: "task-old",
      acceptedSteerSequence: "20", reconciliationStepId: "plan-step", replacementNodeKey: "scout-new", replacementTaskId: "task-new" })
    expect(fixture.query).toHaveBeenCalledTimes(2)
    expect(fixture.query.mock.calls[0]?.[1]).toContain(taskGraphProposalKey("root", 2))
    expect(fixture.query.mock.calls[1]?.[1]).toContain("plan-step")
  })

  it("requires reconciliation to name the exact confirmed steer input", async () => {
    const fixture = fixtures()
    await expect(buildTaskGraphSupersededScoutRetirementPlan({ ...fixture.input,
      confirmed: { ...fixture.input.confirmed, acceptedInputId: "different-steer" } })).resolves.toBeNull()
  })

  it.each([["overlap", ["dublin"]], ["ambiguous selector", ["remote"]]])("rejects %s old scope", async (_label, locations) => {
    expect(await buildTaskGraphSupersededScoutRetirementPlan(fixtures(locations).input)).toBeNull()
  })
})
