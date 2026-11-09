import { describe, expect, it } from "vitest"

import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { isScheduledTaskGraphSpecializedEnvelope } from "./task-graph-pg-specialized-envelope.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, SCHEDULED_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA } from "./scheduled-prepare-task-graph-verification.js"
import { SCHEDULED_POST_GATE_AUDIT_CRITERIA, SCHEDULED_POST_GATE_AUDIT_GOAL, SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_CRITERIA, SCHEDULED_POST_GATE_EXECUTE_GOAL, SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA,
  SCHEDULED_POST_GATE_EXECUTE_ROLE, SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID } from "./scheduled-post-gate-contract.js"
import type { GraphTaskRow } from "./task-graph-pg-state.js"

const auditReport = { processed: 2, applied: 0, queued: 1, pending: 1, skipped: 0, failed: 0, durationMs: 15 }

function snapshot(nodes: readonly Record<string, unknown>[]) {
  return parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes })
}

function auditFixture(input: Readonly<{ node?: Record<string, unknown>; task?: Partial<GraphTaskRow>; result?: unknown }> = {}) {
  const graph = snapshot([
    { key: "gate", templateId: "gate", goal: SCHEDULED_GATE_NODE_GOAL, successCriteria: SCHEDULED_GATE_NODE_CRITERIA,
      dependsOn: [], depth: 4, taskId: "gate-1", verificationDisposition: "specialized" },
    { key: SCHEDULED_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_AUDIT_TEMPLATE_ID, goal: SCHEDULED_AUDIT_NODE_GOAL,
      successCriteria: SCHEDULED_AUDIT_NODE_CRITERIA, dependsOn: ["gate"], depth: 5, taskId: "audit-1",
      verificationDisposition: "specialized", ...input.node },
  ])
  const task: GraphTaskRow = {
    id: "audit-1", status: "completed", role: SCHEDULED_AUDIT_ROLE, taskType: SCHEDULED_AUDIT_TASK_TYPE,
    expectedOutputSchema: SCHEDULED_AUDIT_OUTPUT_SCHEMA, allowedActions: [], contextIsEmpty: true,
    failureReason: null, result: input.result ?? { finalItemId: null, finalText: "", status: "completed", stepCount: 0,
      toolCallCount: 0, taskGraphVerificationReport: null, structuredResult: auditReport },
    ...input.task,
  }
  const node = graph.nodes.find(value => value.key === SCHEDULED_AUDIT_TEMPLATE_ID)!
  return { snapshot: graph, tasks: new Map([[task.id, task]]), node, task }
}

function gateFixture() {
  const graph = snapshot([
    { key: "prepare", templateId: "prepare", goal: "Prepare exact materials", successCriteria: ["Prepared"], dependsOn: [],
      depth: 3, taskId: "prepare-1", verificationDisposition: "specialized" },
    { key: "gate", templateId: "gate", goal: SCHEDULED_GATE_NODE_GOAL, successCriteria: SCHEDULED_GATE_NODE_CRITERIA,
      dependsOn: ["prepare"], depth: 4, taskId: "gate-1", verificationDisposition: "specialized" },
  ])
  const prepareResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "prepare-1", attemptCount: 1,
    snapshotDigest: `sha256:${"a".repeat(64)}`, checkpointDigest: "b".repeat(64), jobs: [{ jobId: "job-1", status: "prepared" }], materials: [] }
  const prepare: GraphTaskRow = { id: "prepare-1", status: "completed", role: "prepare", taskType: "scheduled_application_prepare",
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", taskType: "scheduled_application_prepare" },
    allowedActions: [], contextIsEmpty: true, failureReason: null,
    result: { structuredResult: prepareResult, taskGraphScheduledPrepareProofFacts: {
      schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, result: prepareResult } } }
  const task: GraphTaskRow = { id: "gate-1", status: "completed", role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE,
    expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [], contextIsEmpty: true, failureReason: null,
    result: { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
      taskGraphVerificationReport: null, structuredResult: { status: "completed", nextStage: "execute", approvedJobIds: [],
        pendingJobIds: ["job-1"], skippedJobIds: [], counts: { approved: 0, pending: 1, skipped: 0 } } } }
  return { snapshot: graph, tasks: new Map([[prepare.id, prepare], [task.id, task]]), node: graph.nodes[1]!, task }
}

function postGateFixture(kind: "execute" | "audit", overrides: Readonly<{ executeNode?: Record<string, unknown>;
  auditNode?: Record<string, unknown>; executeTask?: Partial<GraphTaskRow>; auditTask?: Partial<GraphTaskRow> }> = {}) {
  const executeNode = { key: "execute-1", templateId: SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, goal: SCHEDULED_POST_GATE_EXECUTE_GOAL,
    successCriteria: SCHEDULED_POST_GATE_EXECUTE_CRITERIA, dependsOn: ["gate"], packageRefs: ["job-1"], depth: 5,
    taskId: "execute-1", verificationDisposition: "specialized", ...overrides.executeNode }
  const auditNode = { key: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
    goal: SCHEDULED_POST_GATE_AUDIT_GOAL, successCriteria: SCHEDULED_POST_GATE_AUDIT_CRITERIA, dependsOn: ["execute-1"], depth: 6,
    taskId: "audit-1", verificationDisposition: "specialized", ...overrides.auditNode }
  const graph = snapshot([
    { key: "scout", templateId: "scout", goal: "Find candidates", successCriteria: ["Candidate"], dependsOn: [], depth: 1,
      taskId: "scout-1", verificationDisposition: "legacy_unverified" },
    { key: "analyst", templateId: "analyst", goal: "Analyze candidates", successCriteria: ["Finding"], dependsOn: ["scout"], depth: 2,
      taskId: "analyst-1", verificationDisposition: "legacy_unverified" },
    { key: "prepare", templateId: "prepare", goal: "Prepare exact materials", successCriteria: ["Prepared"], dependsOn: ["analyst"],
      depth: 3, taskId: "prepare-1", verificationDisposition: "specialized" },
    { key: "gate", templateId: "gate", goal: SCHEDULED_GATE_NODE_GOAL, successCriteria: SCHEDULED_GATE_NODE_CRITERIA,
      dependsOn: ["prepare"], depth: 4, taskId: "gate-1", verificationDisposition: "specialized" },
    executeNode, auditNode,
  ])
  const executeTask: GraphTaskRow = { id: "execute-1", status: "completed", role: SCHEDULED_POST_GATE_EXECUTE_ROLE,
    taskType: SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, expectedOutputSchema: SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA,
    allowedActions: [], contextIsEmpty: true, failureReason: null, result: { finalItemId: null, finalText: "", status: "completed",
      stepCount: 0, toolCallCount: 0, taskGraphVerificationReport: null, structuredResult: { queued: [], failed: [] } }, ...overrides.executeTask }
  const auditTask: GraphTaskRow = { id: "audit-1", status: "completed", role: SCHEDULED_POST_GATE_AUDIT_ROLE,
    taskType: SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, expectedOutputSchema: SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
    allowedActions: [], contextIsEmpty: true, failureReason: null, result: { finalItemId: null, finalText: "", status: "completed",
      stepCount: 0, toolCallCount: 0, taskGraphVerificationReport: null, structuredResult: auditReport }, ...overrides.auditTask }
  const tasks = new Map([[executeTask.id, executeTask], [auditTask.id, auditTask]])
  const node = graph.nodes.find(value => value.key === (kind === "execute" ? executeNode.key : auditNode.key))!
  return { snapshot: graph, tasks, node, task: kind === "execute" ? executeTask : auditTask }
}

describe("scheduled specialized TaskGraph envelopes", () => {
  it("recognizes the fixed Audit report only with its exact null generic-report sentinel", () => {
    const valid = auditFixture()
    expect(isScheduledTaskGraphSpecializedEnvelope(valid)).toBe("audit")

    const invalid = [
      auditFixture({ result: { finalItemId: null, finalText: "", status: "completed", stepCount: 0,
        toolCallCount: 0, structuredResult: auditReport } }),
      auditFixture({ result: { finalItemId: null, finalText: "", status: "completed", stepCount: 0,
        toolCallCount: 0, taskGraphVerificationReport: { status: "passed" }, structuredResult: auditReport } }),
      auditFixture({ result: { finalItemId: null, finalText: "", status: "completed", stepCount: 0,
        toolCallCount: 0, taskGraphVerificationReport: null, structuredResult: { ...auditReport, failed: -1 } } }),
      auditFixture({ result: { finalItemId: null, finalText: "", status: "completed", stepCount: 0,
        toolCallCount: 0, taskGraphVerificationReport: null, structuredResult: { ...auditReport, unexpected: 0 } } }),
      auditFixture({ result: { finalItemId: null, finalText: "", status: "completed", stepCount: 0,
        toolCallCount: 0, taskGraphVerificationReport: null, structuredResult: auditReport, extra: true } }),
      auditFixture({ task: { role: "reviewer" } }),
      auditFixture({ task: { taskType: "other" } }),
      auditFixture({ task: { expectedOutputSchema: { ...SCHEDULED_AUDIT_OUTPUT_SCHEMA, taskType: "other" } } }),
      auditFixture({ task: { allowedActions: ["agent.plan"] } }),
      auditFixture({ task: { contextIsEmpty: false } }),
      auditFixture({ task: { status: "failed", failureReason: "invalid_structured_result" } }),
      auditFixture({ node: { templateId: "cover_letter_writer" } }),
      auditFixture({ node: { verificationDisposition: "legacy_unverified" } }),
    ]
    for (const fixture of invalid) expect(isScheduledTaskGraphSpecializedEnvelope(fixture)).toBeNull()
  })

  it("preserves the existing fixed Gate envelope branch", () => {
    const valid = gateFixture()
    expect(isScheduledTaskGraphSpecializedEnvelope(valid)).toBe("gate")
    expect(isScheduledTaskGraphSpecializedEnvelope({ ...valid, task: { ...valid.task, role: "reviewer" } })).toBeNull()
  })

  it("recognizes the distinct post-Gate Execute and Audit result envelopes", () => {
    expect(isScheduledTaskGraphSpecializedEnvelope(postGateFixture("execute"))).toBe("execute")
    expect(isScheduledTaskGraphSpecializedEnvelope(postGateFixture("audit"))).toBe("audit")
  })

  it("fails closed on mismatched post-Gate task identity, topology, result, or depth", () => {
    const invalid = [
      postGateFixture("execute", { executeTask: { role: "reviewer" } }),
      postGateFixture("execute", { executeTask: { taskType: "scheduled_taskgraph_gate" } }),
      postGateFixture("execute", { executeTask: { expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA } }),
      postGateFixture("execute", { executeTask: { result: { finalItemId: null, finalText: "", status: "completed", stepCount: 0,
        toolCallCount: 0, taskGraphVerificationReport: null, structuredResult: { queued: ["job-2"], failed: [] } } } }),
      postGateFixture("execute", { auditNode: { dependsOn: ["execute-1", "scout"] } }),
      postGateFixture("audit", { auditTask: { role: "reviewer" } }),
      postGateFixture("audit", { auditTask: { taskType: SCHEDULED_AUDIT_TASK_TYPE } }),
      postGateFixture("audit", { auditTask: { status: "failed" } }),
      postGateFixture("audit", { executeTask: { status: "failed" } }),
      postGateFixture("audit", { auditNode: { dependsOn: ["execute-1", "scout"] } }),
    ]
    for (const fixture of invalid) expect(isScheduledTaskGraphSpecializedEnvelope(fixture)).toBeNull()
  })
})
