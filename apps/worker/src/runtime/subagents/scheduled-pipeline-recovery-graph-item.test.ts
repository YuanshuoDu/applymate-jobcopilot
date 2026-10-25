import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { describe, expect, it } from "vitest"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { classifyScheduledPipelineRecoveryGraphItem } from "./scheduled-pipeline-recovery-graph-item.js"
import { taskGraphItemId, taskGraphProposalKey, TASK_GRAPH_ITEM_TYPE, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"

const owner: TurnExecutionOwnerFence = { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseVersion: 3,
  leaseExpiresAt: new Date("2026-10-25T12:00:00.000Z") }
const rootId = owner.rootTaskId
const itemId = taskGraphItemId(rootId)
const proposalRevision = 6
const proposalDate = new Date("2026-10-25T12:10:00.000Z").toISOString()
const persistedDate = new Date("2026-10-25T12:00:00.000Z").toISOString()
const lifecycleDate = new Date("2026-10-25T12:20:00.000Z").toISOString()
const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
  { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
  { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
] }
const analystVerification = (scoutKey: string) => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
  { id: "scout-membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: scoutKey } },
  { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
] })
type RecoveryGraphNode = { key: string; templateId: string; goal: string; successCriteria: readonly string[]; dependsOn: string[];
  depth: number; taskId: string; verificationDisposition: string; verification?: unknown }
type RecoveryGraphContent = { schemaVersion: string; nodes: RecoveryGraphNode[] }
const contentFor = (auditTaskId = "audit-child-1", scoutKey = "scout", analystKey = "analyst"): RecoveryGraphContent => ({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
  { key: scoutKey, templateId: "scout", goal: "Find evidence", successCriteria: ["Found evidence"], dependsOn: [], depth: 1,
    taskId: "scout-child-1", verificationDisposition: "typed", verification: scoutVerification },
  { key: analystKey, templateId: "analyst", goal: "Review evidence", successCriteria: ["Reviewed evidence"], dependsOn: [scoutKey], depth: 2,
    taskId: "analyst-child-1", verificationDisposition: "typed", verification: analystVerification(scoutKey) },
  { key: "prepare", templateId: "prepare", goal: "Prepare the application", successCriteria: ["Preparation is complete"], dependsOn: [analystKey], depth: 3,
    taskId: "prepare-child-1", verificationDisposition: "specialized" },
  { key: "gate", templateId: "gate", goal: "Review the application", successCriteria: ["Review is complete"], dependsOn: ["prepare"], depth: 4,
    taskId: "gate-child-1", verificationDisposition: "specialized" },
  { key: SCHEDULED_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_AUDIT_TEMPLATE_ID, goal: SCHEDULED_AUDIT_NODE_GOAL,
    successCriteria: SCHEDULED_AUDIT_NODE_CRITERIA, dependsOn: ["gate"], depth: 5,
    taskId: auditTaskId, verificationDisposition: "specialized" },
] })

type GraphItem = Readonly<Record<string, unknown>>
type GraphEvent = Readonly<Record<string, unknown>>
function graphItem(stepId: string, content: unknown, revision = proposalRevision + 1, overrides: Record<string, unknown> = {}): GraphItem {
  return { id: itemId, sessionId: owner.sessionId, turnId: owner.turnId, stepId, taskId: rootId,
    type: TASK_GRAPH_ITEM_TYPE, status: "streaming", phase: null, revision, content,
    startedAt: persistedDate, createdAt: persistedDate, updatedAt: lifecycleDate, ...overrides }
}
function planEvent(stepId: string, revision: number, content: unknown, id = `${stepId}-proposal`, overrides: Record<string, unknown> = {}): GraphEvent {
  const dto = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: owner.sessionId, turnId: owner.turnId,
    stepId, taskId: rootId, type: TASK_GRAPH_ITEM_TYPE, status: "streaming", phase: null, revision, content,
    startedAt: proposalDate, completedAt: null, createdAt: proposalDate, updatedAt: proposalDate }
  const auditTaskId = (content as { nodes: readonly { key: string; taskId: string }[] }).nodes[4]!.taskId
  const payload = { kind: "proposal", fingerprint: "f".repeat(64), revision,
    receipt: { status: "accepted", revision,
      nodes: [{ key: SCHEDULED_AUDIT_TEMPLATE_ID, taskId: auditTaskId, status: "queued" }], readyTaskIds: [auditTaskId] },
    item: dto, content }
  return { id, sessionId: owner.sessionId, turnId: owner.turnId, taskId: rootId, itemId,
    type: "item.delta", actor: "orchestrator", correlationId: owner.turnId, causationId: stepId,
    idempotencyKey: taskGraphProposalKey(rootId, revision - 1), payload, ...overrides }
}
function classify(stepId: string, items: readonly GraphItem[], events: readonly GraphEvent[]) {
  return classifyScheduledPipelineRecoveryGraphItem({ owner, stepId, items, events })
}

describe("scheduled pipeline recovery graph item classification", () => {
  it("accepts the exact current proposal when lifecycle advanced only the row revision", () => {
    const content = contentFor(), event = planEvent("recovery-step-1", proposalRevision, content)
    const item = graphItem("recovery-step-1", content)
    expect(item.revision).toBe(proposalRevision + 1)
    expect(Date.parse(String(item.startedAt))).toBeLessThan(Date.parse((event.payload as { item: { startedAt: string } }).item.startedAt))
    expect(Date.parse(String(item.createdAt))).toBeLessThan(Date.parse((event.payload as { item: { createdAt: string } }).item.createdAt))
    expect(item.content).toEqual((event.payload as { content: unknown }).content)
    expect(classify("recovery-step-1", [item], [event])).toBe("verified_plan")
  })

  it("accepts the scheduled Scout and Analyst keys while preserving semantic templates", () => {
    const content = contentFor("audit-child-1", "scheduled-scout", "scheduled-analyst"), stepId = "recovery-step-1"
    expect(classify(stepId, [graphItem(stepId, content)], [planEvent(stepId, proposalRevision, content)])).toBe("verified_plan")
  })

  it("allows the exact graph item beside a scheduled Gate question item", () => {
    const content = contentFor(), stepId = "recovery-step-1"
    const question = { id: "agent-wait:question:gate-question-1", sessionId: owner.sessionId,
      turnId: owner.turnId, stepId, taskId: rootId, type: "question", status: "started", phase: null,
      revision: 1, content: { waitKind: "question", questionId: "gate-question-1" } }
    expect(classify(stepId, [graphItem(stepId, content), question], [planEvent(stepId, proposalRevision, content)])).toBe("verified_plan")
  })

  it("treats the moved R1 singleton as absent for R1 and requires an R2 receipt for R2", () => {
    const r1 = "recovery-step-1", r2 = "recovery-step-2", content = contentFor()
    const r1Event = planEvent(r1, proposalRevision, content)
    const r2Event = planEvent(r2, proposalRevision + 1, content)
    const moved = graphItem(r2, content, proposalRevision + 2)
    expect(classify(r1, [], [r1Event])).toBe("absent")
    expect(classify(r2, [moved], [r1Event])).toBe("invalid")
    expect(classify(r2, [moved], [r2Event])).toBe("verified_plan")
  })

  it.each([
    ["missing proposal event", [], ["recovery-step-1"]],
    ["duplicate proposal event", ["recovery-step-1", "recovery-step-1"], ["recovery-step-1"]],
    ["duplicate graph singleton", ["recovery-step-1"], ["recovery-step-1", "recovery-step-1"]],
    ["foreign row scope", ["recovery-step-1"], ["recovery-step-1"]],
    ["wrong proposal key", ["recovery-step-1"], ["recovery-step-1"]],
    ["changed current content", ["recovery-step-1"], ["recovery-step-1"]],
    ["wrong causal step", ["recovery-step-1"], ["recovery-step-1"]],
  ] as const)("rejects %s", (label, eventSteps, itemSteps) => {
    const stepId = "recovery-step-1", content = contentFor()
    const events = eventSteps.map((step, index) => planEvent(step, proposalRevision, content, `event-${index}`, {
      ...(label === "wrong proposal key" ? { idempotencyKey: "wrong-proposal-key" } : {}),
      ...(label === "wrong causal step" ? { causationId: "other-step" } : {}),
    }))
    const items = itemSteps.map((step, index) => graphItem(step, content, proposalRevision + 1, {
      id: label === "duplicate graph singleton" ? itemId : itemId,
      ...(label === "foreign row scope" ? { sessionId: "foreign-session" } : {}),
      ...(label === "changed current content" ? { content: { ...content, changed: true } } : {}),
    }))
    const eventRows = label === "missing proposal event" ? [] : events
    expect(classify(stepId, items, eventRows)).toBe("invalid")
  })

  it.each(["unexpected base-node order", "broken predecessor edge", "wrong semantic template", "duplicate aliases",
    "fixed key collision", "invalid alias", "root task reused as a child"] as const)("rejects %s", change => {
    const valid = contentFor()
    const nodes = [...valid.nodes]
    if (change === "unexpected base-node order") [nodes[0], nodes[1]] = [nodes[1]!, nodes[0]!]
    else if (change === "broken predecessor edge") nodes[2] = { ...nodes[2]!, dependsOn: ["scout"] }
    else if (change === "wrong semantic template") nodes[0] = { ...nodes[0]!, templateId: "analyst" }
    else if (change === "duplicate aliases") { nodes[0] = { ...nodes[0]!, key: "same" }; nodes[1] = { ...nodes[1]!, key: "same", dependsOn: ["same"] } }
    else if (change === "fixed key collision") nodes[0] = { ...nodes[0]!, key: "prepare" }
    else if (change === "invalid alias") nodes[0] = { ...nodes[0]!, key: " " }
    else nodes[0] = { ...nodes[0]!, taskId: rootId }
    const changed = { ...valid, nodes }
    const stepId = "recovery-step-1"
    expect(classify(stepId, [graphItem(stepId, changed)], [planEvent(stepId, proposalRevision, changed)])).toBe("invalid")
  })

  it("distinguishes absence from an orphan proposal receipt", () => {
    const content = contentFor()
    expect(classify("recovery-step-1", [], [])).toBe("absent")
    expect(classify("recovery-step-1", [graphItem("recovery-step-1", content)], [])).toBe("invalid")
  })
})
