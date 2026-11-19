import { describe, expect, it } from "vitest"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.js"
import { taskGraphItemId, taskGraphState, parseTaskGraphSnapshot, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import type { TaskGraphObjectiveLineageNode } from "../planning/task-graph-objective-lineage.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-template-definitions.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { STEERING_RECONCILIATION_SCHEMA_VERSION, steeringReconciliationIdempotencyKey } from "./steering-reconciliation-contract.js"
import type { PreparedSteeringReconciliation, SteeringReconciliationState } from "./steering-reconciliation-contract.js"
import { classifyPendingSupersededScouts } from "./task-graph-pending-scout-scope.js"
import { templatesForInteractiveScoutDelegation } from "./nested-scout-profile.js"

const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}
const acceptedInputSequence = 20n
const confirmed = { kind: "confirmed" as const, locations: ["dublin"], acceptedInputSequence, acceptedInputId: "input-1" }
const locationCriterion = (locations: readonly string[]) => ({ id: "candidate-location",
  check: { kind: "candidate_location_in" as const, locations } })
const verification = (locations: readonly string[]) => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout" as const,
  criteria: [
    { id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } },
    locationCriterion(locations),
  ] })
const current = (key = "new-scout", locations: readonly string[] = ["dublin"], dependsOn: readonly string[] = []): TaskGraphObjectiveLineageNode => ({
  key, templateId: "scout", dependsOn, verificationDisposition: "typed" as const, verification: verification(locations),
})

type Spec = Readonly<{
  key: string
  taskId: string
  locations: readonly string[]
  checkpoint?: bigint | null
  status?: GraphTaskRow["status"]
  role?: string
  taskType?: string
  dependsOn?: readonly string[]
  nestedProfile?: boolean
  canonicalNestedContext?: boolean
}>

function persistedNode(spec: Spec, index: number): StoredTaskGraphNode {
  const template = spec.nestedProfile
    ? templatesForInteractiveScoutDelegation(TASK_GRAPH_TEMPLATES, TASK_GRAPH_TEMPLATES)?.scout ?? TASK_GRAPH_TEMPLATES.scout
    : TASK_GRAPH_TEMPLATES.scout
  return {
    key: spec.key, taskId: spec.taskId, templateId: "scout", goal: "Find suitable jobs",
    successCriteria: ["Return verified job evidence"], dependsOn: spec.dependsOn ?? [], depth: index + 1,
    verificationDisposition: "typed", verification: verification(spec.locations),
    registeredScoutEnvelope: {
      role: "scout", taskType: template.taskType,
      expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema,
      allowedActions: template.allowedActions,
    },
  }
}

function loadedGraph(specs: readonly Spec[]): LoadedGraph {
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: specs.map(persistedNode) })
  const tasks = new Map<string, GraphTaskRow>(specs.map(spec => {
    const template = spec.nestedProfile
      ? templatesForInteractiveScoutDelegation(TASK_GRAPH_TEMPLATES, TASK_GRAPH_TEMPLATES)?.scout ?? TASK_GRAPH_TEMPLATES.scout
      : TASK_GRAPH_TEMPLATES.scout
    return [spec.taskId, {
      id: spec.taskId, status: spec.status ?? "running", role: spec.role ?? "scout", taskType: spec.taskType ?? "job_discovery",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, allowedActions: template.allowedActions,
      contextIsObject: true, contextIsEmpty: !spec.nestedProfile,
      contextIsCanonicalNestedScoutProfile: spec.nestedProfile ? spec.canonicalNestedContext ?? true : false,
      hasPrivateSelectionContext: false, attemptCount: 1,
      failureReason: null, result: null,
    }]
  }))
  const statuses = new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }] as const))
  const revision = 1
  return {
    rootTaskId: scope.rootTaskId, snapshot, item: { id: taskGraphItemId(scope.rootTaskId), revision, content: snapshot, createdAt: null },
    state: taskGraphState(snapshot, revision, statuses, []), tasks,
    currentInputCheckpoint: { inputThroughSequence: acceptedInputSequence },
    sourceInputCheckpointByNodeKey: new Map(specs.map(spec => [spec.key,
      spec.checkpoint === null ? null : { inputThroughSequence: spec.checkpoint ?? 10n }])),
  }
}

const reconciliation: SteeringReconciliationState = {
  originalInputId: null, currentRevision: 1, decisionStepId: scope.stepId, decisionStepOrdinal: 2, decisionStepAttempt: 1,
  decisionInputThroughSequence: acceptedInputSequence, agendaPlanRevision: 1, lastReconciledInputThroughSequence: 10n,
  unresolvedInputs: [{ id: "input-1", acceptedSequence: acceptedInputSequence, status: "consumed",
    consumedByStepId: scope.stepId, consumingOrdinal: 2 }],
}

function prepared(): PreparedSteeringReconciliation {
  const inputIds = ["input-1"], callId = "plan-call-1"
  return {
    scope, callId, decision: "revise", expectedRevision: 1, resultingRevision: 2, steerInputIds: inputIds,
    inputThroughSequence: acceptedInputSequence, idempotencyKey: steeringReconciliationIdempotencyKey(scope, callId)!,
    receipt: { schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: scope.sessionId, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, stepId: scope.stepId, decision: "revise", observedRevision: 1, resultingRevision: 2,
      steerInputIds: inputIds, inputCheckpoint: { throughSequence: acceptedInputSequence.toString() } },
  }
}

function lineage(loaded: LoadedGraph, added: readonly TaskGraphObjectiveLineageNode[] = [current()]) {
  const stored = loaded.snapshot?.nodes ?? []
  return [
    ...stored.map(node => ({ key: node.key, taskId: node.taskId, templateId: node.templateId, dependsOn: node.dependsOn,
      verification: node.verification, verificationDisposition: node.verificationDisposition, ...(node.repairOf ? { repairOf: node.repairOf } : {}) })),
    ...added,
  ]
}

function decide(specs: readonly Spec[], options: Readonly<{
  prepared?: PreparedSteeringReconciliation
  reconciliation?: SteeringReconciliationState
  acceptedSequence?: bigint
  added?: readonly TaskGraphObjectiveLineageNode[]
}> = {}) {
  const loaded = loadedGraph(specs)
  return classifyPendingSupersededScouts({ loaded, scope, reconciliation: options.reconciliation ?? reconciliation,
    prepared: options.prepared ?? prepared(), confirmed: { ...confirmed,
      acceptedInputSequence: options.acceptedSequence ?? acceptedInputSequence }, expectedRevision: 1,
    nodes: lineage(loaded, options.added) })
}

describe("pending superseded Scout scope", () => {
  it("partitions only an older ordinary running Scout with a disjoint exact label", () => {
    const loaded = loadedGraph([
      { key: "old-berlin", taskId: "task-berlin", locations: ["berlin"] },
      { key: "same-dublin", taskId: "task-dublin", locations: ["dublin"] },
    ])
    const before = JSON.stringify(loaded.snapshot)
    const result = classifyPendingSupersededScouts({ loaded, scope, reconciliation, prepared: prepared(), confirmed,
      expectedRevision: 1, nodes: lineage(loaded) })

    expect(result).toEqual({ status: "available", pendingNodeKeys: new Set(["old-berlin"]) })
    expect(JSON.stringify(loaded.snapshot)).toBe(before)
    expect([...loaded.tasks.values()].map(task => task.status)).toEqual(["running", "running"])
  })

  it("uses verifier label equality and refuses policy-recognized remote or wildcard selectors", () => {
    expect(decide([{ key: "old-ireland", taskId: "task-ireland", locations: ["ireland"] }]))
      .toEqual({ status: "available", pendingNodeKeys: new Set(["old-ireland"]) })
    expect(decide([{ key: "remote", taskId: "task-remote", locations: ["remote"] }])).toEqual({ status: "unavailable" })
    expect(decide([{ key: "wildcard", taskId: "task-wildcard", locations: ["*"] }])).toEqual({ status: "unavailable" })
  })

  it("admits the exact registered nested Scout profile and rejects a noncanonical marker projection", () => {
    expect(decide([{ key: "old-berlin", taskId: "task-berlin", locations: ["berlin"], nestedProfile: true }]))
      .toEqual({ status: "available", pendingNodeKeys: new Set(["old-berlin"]) })
    expect(decide([{ key: "old-berlin", taskId: "task-berlin", locations: ["berlin"], nestedProfile: true,
      canonicalNestedContext: false }])).toEqual({ status: "unavailable" })
  })

  it.each([
    ["keep", { prepared: { ...prepared(), decision: "keep" as const } }],
    ["stale revision", { prepared: { ...prepared(), expectedRevision: 0 } }],
    ["different accepted sequence", { acceptedSequence: 21n }],
    ["additional pending input", { reconciliation: { ...reconciliation, unresolvedInputs: [
      ...reconciliation.unresolvedInputs,
      { id: "input-2", acceptedSequence: 21n, status: "consumed" as const, consumedByStepId: scope.stepId, consumingOrdinal: 2 },
    ] } }],
  ] as const)("does not admit a superseded partition with %s authority", (_label, options) => {
    expect(decide([{ key: "old-berlin", taskId: "task-berlin", locations: ["berlin"] }], options)).toEqual({ status: "unavailable" })
  })

  it("does not classify unsupported task identity, task type, dependency, or repair shapes", () => {
    expect(decide([{ key: "wrong-role", taskId: "task-role", locations: ["berlin"], role: "analyst" }]))
      .toEqual({ status: "unavailable" })
    expect(decide([{ key: "wrong-type", taskId: "task-type", locations: ["berlin"], taskType: "selected_job_discovery" }]))
      .toEqual({ status: "unavailable" })
    expect(decide([
      { key: "base", taskId: "task-base", locations: ["berlin"] },
      { key: "depends", taskId: "task-depends", locations: ["berlin"], dependsOn: ["base"] },
    ])).toEqual({ status: "unavailable" })
    expect(decide([{ key: "old-berlin", taskId: "task-berlin", locations: ["berlin"] }], {
      added: [current(), { key: "repair", templateId: "analyst", dependsOn: [], repairOf: {
        graphRootTaskId: scope.rootTaskId, nodeKey: "old-berlin", taskId: "task-berlin", criterionIds: ["candidate-count"],
      } }],
    })).toEqual({ status: "unavailable" })
  })

  it("requires a fresh matching Scout and no current or proposed lineage reference", () => {
    expect(decide([{ key: "old-berlin", taskId: "task-berlin", locations: ["berlin"] }], { added: [] }))
      .toEqual({ status: "unavailable" })
    expect(decide([{ key: "old-berlin", taskId: "task-berlin", locations: ["berlin"] }], {
      added: [current(), { key: "new-analysis", templateId: "analyst", dependsOn: ["old-berlin"] }],
    })).toEqual({ status: "unavailable" })
  })

  it("accepts a canonical pre-persistence Scout proposal but rejects an explicit legacy disposition", () => {
    const { verificationDisposition: _disposition, ...proposed } = current()
    const old = [{ key: "old-berlin", taskId: "task-berlin", locations: ["berlin"] }]
    expect(decide(old, { added: [proposed] })).toEqual({ status: "available", pendingNodeKeys: new Set(["old-berlin"]) })
    expect(decide(old, { added: [{ ...proposed, verificationDisposition: "legacy_unverified" }] }))
      .toEqual({ status: "unavailable" })
  })

  it("keeps a source created at or after the accepted boundary out of the pending partition", () => {
    expect(decide([{ key: "newer", taskId: "task-newer", locations: ["berlin"], checkpoint: acceptedInputSequence }]))
      .toEqual({ status: "available", pendingNodeKeys: new Set() })
  })
})
