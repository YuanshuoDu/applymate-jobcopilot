import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphNodeProposal } from "../planning/task-graph.js"
import { validateTaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import { assertTaskGraphBranchRepairHistory } from "./steering-reconciliation-branch-repair-history.js"
import { steeringReconciliationIdempotencyKey } from "./steering-reconciliation-contract.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import {
  taskGraphItemId,
  taskGraphLifecycleKey,
  taskGraphProposalKey,
  parseTaskGraphSnapshot,
  TASK_GRAPH_SNAPSHOT_VERSION,
  type StoredTaskGraphNode,
  type TaskGraphSnapshot,
} from "./task-graph-snapshot.js"
import {
  TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
  parseTaskGraphBranchRepairRelation,
  taskGraphBranchRepairFingerprint,
  type TaskGraphBranchRepairCall,
  type TaskGraphBranchRepairRelation,
} from "./task-graph-pg-branch-repair-relation.js"
import type { TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import { executionKey } from "../turns/turn-execution-types.js"

type Row = Record<string, unknown>
const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "decision-step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}
const rootCriteria = ["Keep the original Root objective"]
const scoutVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 2 } }],
}
const analystVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst" as const,
  criteria: [
    { id: "from-scout", check: { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: "scout-old" } },
    { id: "from-scout-union", check: { kind: "findings_from_scout_union" as const, dependencyNodeKeys: ["scout-old", "foundation"] } },
    { id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } },
  ],
}

function storedNode(input: Readonly<{ key: string; taskId: string; templateId?: string; dependsOn?: readonly string[]; depth?: number;
  verification?: StoredTaskGraphNode["verification"] }>): StoredTaskGraphNode {
  const templateId = input.templateId ?? "scout"
  return {
    key: input.key, taskId: input.taskId, templateId, goal: `Old plan for ${input.key}`,
    successCriteria: ["Old explanatory criterion"], dependsOn: [...(input.dependsOn ?? [])], depth: input.depth ?? 1,
    verificationDisposition: "typed", verification: input.verification ?? (templateId === "analyst" ? analystVerification : scoutVerification),
  }
}

function initialSnapshot(): TaskGraphSnapshot {
  return {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, rootSuccessCriteria: rootCriteria,
    nodes: [
      storedNode({ key: "foundation", taskId: "foundation-task" }),
      storedNode({ key: "scout-old", taskId: "scout-old-task", dependsOn: ["foundation"], depth: 2 }),
      storedNode({ key: "analyst-old", taskId: "analyst-old-task", templateId: "analyst", dependsOn: ["scout-old", "foundation"], depth: 3 }),
      storedNode({ key: "unrelated", taskId: "unrelated-task" }),
    ],
  }
}

function branch(): TaskGraphBranchReplacement {
  return {
    root: { nodeKey: "scout-old", taskId: "scout-old-task" },
    sources: [
      { nodeKey: "scout-old", taskId: "scout-old-task", replacementKey: "scout-new" },
      { nodeKey: "analyst-old", taskId: "analyst-old-task", replacementKey: "analyst-new" },
    ],
  }
}

function proposals(changedScoutMinimum?: number): TaskGraphNodeProposal[] {
  const scout = changedScoutMinimum === undefined ? scoutVerification : {
    ...scoutVerification, criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: changedScoutMinimum } }],
  }
  const analyst = {
    ...analystVerification,
    criteria: analystVerification.criteria.map(criterion => criterion.check.kind === "findings_from_scout_dependency"
      ? { ...criterion, check: { ...criterion.check, dependencyNodeKey: "scout-new" } }
      : criterion.check.kind === "findings_from_scout_union" ? { ...criterion,
        check: { ...criterion.check, dependencyNodeKeys: criterion.check.dependencyNodeKeys.map(key => key === "scout-old" ? "scout-new" : key) } }
        : criterion),
  }
  return [
    { key: "scout-new", templateId: "scout", goal: "Try a refreshed search approach", successCriteria: ["Find updated roles"],
      dependsOn: ["foundation"], verification: scout },
    { key: "analyst-new", templateId: "analyst", goal: "Reassess the refreshed evidence", successCriteria: ["Explain strongest matches"],
      dependsOn: ["scout-new", "foundation"], verification: analyst },
  ]
}

function toolStartKey(callId: string): string {
  const identity = { kind: "turn" as const, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner,
    leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) }
  return `${executionKey(identity)}:event:tool-started:${callId}`
}

function fixture(options: Readonly<{ changedScoutMinimum?: number }> = {}) {
  const before = initialSnapshot(), replaceBranch = branch(), callId = "branch-plan-call", expectedRevision = 4
  const proposedNodes = proposals(options.changedScoutMinimum)
  const callInput: TaskGraphBranchRepairCall = { expectedRevision, replaceBranch, nodes: proposedNodes, rootSuccessCriteria: rootCriteria }
  const replacementNodes: StoredTaskGraphNode[] = proposedNodes.map((node, index) => ({ ...node,
    taskId: index === 0 ? "scout-new-task" : "analyst-new-task", depth: index === 0 ? 2 : 3, verificationDisposition: "typed" }))
  const retained = before.nodes.filter(node => !replaceBranch.sources.some(source => source.nodeKey === node.key))
  const after: TaskGraphSnapshot = { ...before, nodes: [...retained, ...replacementNodes] }
  const fingerprint = taskGraphBranchRepairFingerprint(callInput)
  const relationCandidate = {
    schemaVersion: TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
    operationKey: steeringReconciliationIdempotencyKey(scope, callId), graphRootTaskId: scope.rootTaskId,
    observedRevision: expectedRevision, resultingRevision: expectedRevision + replaceBranch.sources.length + 1,
    root: replaceBranch.root,
    sources: replaceBranch.sources.map((source, index) => ({
      source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacementKey: source.replacementKey,
      cancellationEvent: { id: `cancel-${source.nodeKey}`, sequence: String(41 + index) },
    })),
    planEvent: { id: "branch-plan-event", sequence: "43", idempotencyKey: taskGraphProposalKey(scope.rootTaskId, expectedRevision + replaceBranch.sources.length) },
    replacementFingerprint: fingerprint,
    agentPlanCall: { callId, stepId: scope.stepId, expectedRevision, replaceBranch },
  }
  const relation = parseTaskGraphBranchRepairRelation(relationCandidate)
  if (!relation) throw new Error("branch repair relation fixture must be valid")

  const graphId = taskGraphItemId(scope.rootTaskId)
  const cancellations: Row[] = replaceBranch.sources.map((source, index) => {
    const revision = expectedRevision + index + 1
    const cancellationKey = taskGraphLifecycleKey(scope.rootTaskId, source.nodeKey, 0, "task.cancelled")
    return {
      id: `cancel-${source.nodeKey}`, itemId: graphId, taskId: source.taskId, type: "item.delta", actor: "system",
      correlationId: scope.turnId, causationId: scope.stepId, sequence: String(41 + index), idempotencyKey: cancellationKey, hasOutbox: true,
      payload: {
        kind: "lifecycle", revision,
        event: { type: "task.cancelled", nodeKey: source.nodeKey, expectedRevision: revision - 1, idempotencyKey: cancellationKey },
        item: { id: graphId, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
          type: "task_graph", revision, content: before },
      },
    }
  })
  const scheduleReceipt = {
    status: "accepted", revision: relation.resultingRevision,
    nodes: [
      { key: "scout-new", taskId: "scout-new-task", status: "queued" },
      { key: "analyst-new", taskId: "analyst-new-task", status: "waiting" },
    ],
    readyTaskIds: ["scout-new-task"],
  }
  const planEvent: Row = {
    id: relation.planEvent.id, itemId: graphId, taskId: scope.rootTaskId, type: "item.delta", actor: "orchestrator",
    correlationId: scope.turnId, causationId: scope.stepId, sequence: relation.planEvent.sequence,
    idempotencyKey: relation.planEvent.idempotencyKey, hasOutbox: true,
    payload: { kind: "proposal", fingerprint, revision: relation.resultingRevision, receipt: scheduleReceipt, content: after,
      item: { id: graphId, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
        type: "task_graph", revision: relation.resultingRevision, content: after } },
  }
  const callRow: Row = {
    eventId: "plan-call-event", eventSequence: "40", type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId,
    eventItemId: "plan-call-item", correlationId: callId, idempotencyKey: toolStartKey(callId),
    payload: { toolCallId: callId, toolName: "agent.plan", taskId: scope.rootTaskId },
    callItemId: "plan-call-item", stepId: scope.stepId, itemTaskId: scope.rootTaskId, itemType: "tool_call",
    itemContent: { toolCallId: callId, toolName: "agent.plan", toolVersion: "1", input: callInput },
  }
  const events = [...cancellations, planEvent]
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('event."id" = ANY($3::text[])')) {
      const ids = values?.[2] as string[]
      const rows = events.filter(event => ids.includes(String(event.id)))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes("tool_call.started")) {
      const matches = values?.[4] === callRow.stepId && values?.[5] === scope.userId
      return { rows: matches ? [callRow] : [], rowCount: matches ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 }
  })
  const client = { query } as unknown as Pick<PoolClient, "query">
  return { client, query, events, callRow, relation, proposedNodes,
    receiptEvent: { id: "reconciliation-receipt", sequence: 44n, stepId: scope.stepId,
      idempotencyKey: relation.operationKey } }
}

function changePlanContent(f: ReturnType<typeof fixture>, content: TaskGraphSnapshot): void {
  const event = f.events.find(row => row.id === f.relation.planEvent.id)!
  const payload = event.payload as Row, item = payload.item as Row
  event.payload = { ...payload, content, item: { ...item, content } }
}

describe("persisted TaskGraph branch repair history", () => {
  it("accepts ordered closure cancellations followed by the matching full plan write", async () => {
    const f = fixture()
    const before = parseTaskGraphSnapshot((f.events[0]!.payload as Row).item && ((f.events[0]!.payload as Row).item as Row).content)
    const call = (f.callRow.itemContent as Row).input as TaskGraphBranchRepairCall
    const validation = validateTaskGraphBranchReplacement({ snapshot: before, replaceBranch: f.relation.agentPlanCall.replaceBranch,
      proposal: { expectedRevision: call.expectedRevision, nodes: f.proposedNodes }, proposedRootSuccessCriteria: call.rootSuccessCriteria })
    expect(validation).toMatchObject({ ok: true })
    await expect(assertTaskGraphBranchRepairHistory(f.client, scope, f.relation, f.receiptEvent)).resolves.toMatchObject({
      status: "accepted", revision: 7, nodes: [{ key: "scout-new" }, { key: "analyst-new" }],
    })
    expect(f.events.map(event => event.id)).toEqual(["cancel-scout-old", "cancel-analyst-old", "branch-plan-event"])
    expect(f.query).toHaveBeenCalledTimes(2)
  })

  it("validates an immutable prior-Step receipt against its persisted call while retaining the current owner scope", async () => {
    const f = fixture(), laterScope = { ...scope, stepId: "later-decision-step" }
    await expect(assertTaskGraphBranchRepairHistory(f.client, laterScope, f.relation, f.receiptEvent)).resolves.toMatchObject({ status: "accepted" })
    const { stepId: currentStepId, ...ownerScope } = scope
    expect(currentStepId).toBe("decision-step")
    await expect(assertTaskGraphBranchRepairHistory(f.client, ownerScope, f.relation, f.receiptEvent)).resolves.toMatchObject({ status: "accepted" })
    const callQuery = f.query.mock.calls.find(([sql]) => sql.includes("tool_call.started"))
    expect(callQuery?.[1]).toEqual([scope.sessionId, scope.turnId, scope.rootTaskId, f.relation.agentPlanCall.callId, scope.stepId, scope.userId])
  })

  it("rejects a relation bound to a foreign Step or a mismatched persisted receipt key", async () => {
    const f = fixture(), foreignStepId = "foreign-step"
    const foreignKey = steeringReconciliationIdempotencyKey({ ...scope, stepId: foreignStepId }, f.relation.agentPlanCall.callId)!
    const misbound = { ...f.relation, operationKey: foreignKey,
      agentPlanCall: { ...f.relation.agentPlanCall, stepId: foreignStepId } }
    await expect(assertTaskGraphBranchRepairHistory(f.client, scope, misbound,
      { ...f.receiptEvent, stepId: foreignStepId, idempotencyKey: foreignKey }))
      .rejects.toThrow("steering_reconciliation_branch_repair_event_invalid")
    await expect(assertTaskGraphBranchRepairHistory(f.client, scope, misbound, f.receiptEvent))
      .rejects.toThrow("steering_reconciliation_branch_repair_event_invalid")
    await expect(assertTaskGraphBranchRepairHistory(f.client, scope, f.relation,
      { ...f.receiptEvent, idempotencyKey: foreignKey }))
      .rejects.toThrow("steering_reconciliation_branch_repair_event_invalid")
  })

  it.each([
    ["root criteria", (f: ReturnType<typeof fixture>) => changePlanContent(f, {
      ...(initialSnapshot()), rootSuccessCriteria: ["Altered objective"],
      nodes: [...initialSnapshot().nodes.filter(node => !["scout-old", "analyst-old"].includes(node.key)),
        ...((f.events.find(row => row.id === f.relation.planEvent.id)!.payload as Row).content as TaskGraphSnapshot).nodes
          .filter(node => node.key === "scout-new" || node.key === "analyst-new")],
    })],
    ["schedule receipt revision", (f: ReturnType<typeof fixture>) => {
      const event = f.events.find(row => row.id === f.relation.planEvent.id)!
      const payload = event.payload as Row, receipt = payload.receipt as Row
      event.payload = { ...payload, receipt: { ...receipt, revision: 6 } }
    }],
    ["cancellation lineage", (f: ReturnType<typeof fixture>) => {
      f.events[0] = { ...f.events[0]!, actor: "orchestrator" }
    }],
  ] as const)("rejects tampered %s evidence while the referenced rows still exist", async (_name, mutate) => {
    const f = fixture()
    mutate(f)
    await expect(assertTaskGraphBranchRepairHistory(f.client, scope, f.relation, f.receiptEvent))
      .rejects.toThrow("steering_reconciliation_branch_repair_event_invalid")
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('event."id" = ANY($3::text[])'), expect.any(Array))
  })

  it("rejects an extant plan call whose immutable input no longer matches its recorded fingerprint", async () => {
    const f = fixture()
    const item = f.callRow.itemContent as Row, input = item.input as TaskGraphBranchRepairCall
    f.callRow.itemContent = { ...item, input: { ...input, nodes: [
      { ...input.nodes[0]!, goal: "Altered after the receipt was written" }, input.nodes[1]!,
    ] } }
    await expect(assertTaskGraphBranchRepairHistory(f.client, scope, f.relation, f.receiptEvent))
      .rejects.toThrow("steering_reconciliation_branch_repair_event_invalid")
  })

  it("rejects a proposal that changes a typed source verification contract even when its call and fingerprint agree", async () => {
    const f = fixture({ changedScoutMinimum: 3 })
    const plan = f.events.find(row => row.id === f.relation.planEvent.id)!.payload as Row
    expect(plan.fingerprint).toBe(f.relation.replacementFingerprint)
    const alteredNodes = ((f.callRow.itemContent as Row).input as TaskGraphBranchRepairCall).nodes
    expect(alteredNodes[0]).toMatchObject({ verification: { criteria: [{ check: { kind: "candidate_count_gte", minimum: 3 } }] } })
    await expect(assertTaskGraphBranchRepairHistory(f.client, scope, f.relation, f.receiptEvent))
      .rejects.toThrow("steering_reconciliation_branch_repair_event_invalid")
  })
})
