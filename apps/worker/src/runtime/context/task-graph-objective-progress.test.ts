import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { mergeTaskGraphCurrentObservation } from "../canonical-turn-task-graph-context.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION, TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCurrentState } from "../subagents/task-graph-command-port.js"
import { resolveRootTaskVerificationRequirements } from "./root-task-objective.js"
import { taskGraphObjectiveProgressObservation, TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID } from "./task-graph-objective-progress.js"

const rootTaskId = "root-task"
const requirementId = "candidate-total"
const requirement = { id: requirementId, kind: "candidate_count_gte" as const, minimum: 2 }
const resolution = resolveRootTaskVerificationRequirements({ input: { verificationRequirements: {
  schemaVersion: "agent-harness.v2.objective-requirements.v1",
  requirements: [{ id: requirement.id, check: { kind: requirement.kind, minimum: requirement.minimum } }],
} } })
const activeTemplateRoles = { scout: "scout", analyst: "analyst" }

function report(status: "failed" | "passed" | "unverified") {
  const criterionStatus = status === "failed" ? "failed" : status === "passed" ? "passed" : "unverified"
  const reasonCode = status === "failed" ? "criterion_not_met" : status === "passed" ? "criteria_met" : "canonical_evidence_missing"
  return {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status, reasonCode,
    criteria: [{ criterionId: requirementId, status: criterionStatus, reasonCode }],
    evidenceDigest: status === "unverified" ? null : "a".repeat(64),
    resultDigest: status === "unverified" ? null : "b".repeat(64),
  }
}

function node(input: Readonly<{ key?: string; taskId?: string; status?: "queued" | "running" | "failed" | "completed"; minimum?: number; kind?: "candidate_count_gte" | "finding_count_gte" | "evidence_count_gte"; role?: "scout" | "analyst"; report?: "failed" | "passed" | "unverified" }>) {
  const status = input.status ?? "running"
  const role = input.role ?? "scout"
  const minimum = input.minimum ?? 3
  const checkKind = input.kind ?? (role === "scout" ? "candidate_count_gte" : "finding_count_gte")
  const verification = {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role,
    criteria: [{ id: requirementId, check: { kind: checkKind, minimum } }],
  }
  return {
    key: input.key ?? "scout", taskId: input.taskId ?? "scout-task", templateId: role,
    goal: "PRIVATE_NODE_GOAL", successCriteria: ["Find relevant roles"], dependsOn: [], status,
    readiness: status === "queued" ? "ready" : status === "running" ? "active" : "terminal",
    resultSummary: "PRIVATE_RESULT_SUMMARY", failureReason: null,
    resultProjection: { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable" },
    verificationCriterionIds: [requirementId], verification,
    ...(input.report ? { verificationReport: report(input.report) } : {}),
  }
}

function current(nodes: readonly Record<string, unknown>[], revision = 7) {
  return mergeTaskGraphCurrentObservation({ system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }, {
    revision, nodes: nodes as unknown as TaskGraphCurrentState["nodes"],
  })
}

function project(snapshot: ReturnType<typeof current>, overrides: Record<string, unknown> = {}) {
  return taskGraphObjectiveProgressObservation({
    resolution, observations: snapshot.toolObservations, taskGraphRevision: snapshot.taskGraphRevision, rootTaskId,
    taskGraphTemplateRoles: activeTemplateRoles,
    ...overrides,
  } as Parameters<typeof taskGraphObjectiveProgressObservation>[0])
}

describe("TaskGraph objective progress observation", () => {
  it("projects missing, active, failed, unverified, and reported-passed states from exact current reports", () => {
    expect(project(current([]))?.content).toMatchObject({ revision: 7, requirements: [{ ...requirement, status: "missing" }] })
    expect(project(current([node({ status: "running", report: "passed" })]))?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "active" }] })
    expect(project(current([node({ status: "failed", report: "failed" })]))?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "failed" }] })
    expect(project(current([node({ status: "failed", report: "unverified" })]))?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "unverified" }] })
    expect(project(current([node({ status: "completed", report: "passed" })]))?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "reported_passed" }] })
  })

  it("uses the latest valid repair-lineage member and does not trust a passed old target", () => {
    const target = node({ key: "target", taskId: "target-task", status: "completed", report: "passed" })
    const repair = { ...node({ key: "repair", taskId: "repair-task", status: "running", report: "passed" }),
      repairOf: { graphRootTaskId: rootTaskId, nodeKey: "target", taskId: "target-task", criterionIds: [requirementId] } }
    expect(project(current([target, repair]))?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "active" }] })
    const wrongRoot = current([target, repair])
    expect(taskGraphObjectiveProgressObservation({ resolution, observations: wrongRoot.toolObservations,
      taskGraphRevision: wrongRoot.taskGraphRevision, rootTaskId: "another-root" })?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "unknown" }] })
    expect(project(current([target, repair, node({ key: "unrelated", taskId: "unrelated-task" })]))?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "unknown" }] })
  })

  it.each([
    ["wrong check kind", node({ kind: "evidence_count_gte" })],
    ["weaker minimum", node({ minimum: 1 })],
    ["wrong role", node({ role: "analyst" })],
    ["report missing", node({ status: "completed" })],
    ["report status mismatch", node({ status: "failed", report: "passed" })],
  ] as const)("returns unknown for %s", (_name, item) => {
    expect(project(current([item]))?.content).toMatchObject({ requirements: [{ id: requirementId, status: "unknown" }] })
  })

  it("returns unknown for an unsupported typed template", () => {
    const valid = current([node({})])
    const observation = valid.toolObservations[0]!
    const content = observation.content as { nodes: Array<Record<string, unknown>> }
    const malformed = { ...observation, content: { ...content, nodes: [{ ...content.nodes[0], templateId: "custom-scout" }] } }
    expect(project(valid, { observations: [malformed] })?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "unknown" }] })
  })

  it("returns unknown for legacy exact-ID bindings without a typed contract or an active matching role", () => {
    const valid = current([node({})])
    const observation = valid.toolObservations[0]!
    const content = observation.content as { nodes: Array<Record<string, unknown>> }
    const legacyNode = { ...content.nodes[0] }
    delete legacyNode.verification
    const legacy = { ...observation, content: { ...content, nodes: [legacyNode] } }
    expect(project(valid, { observations: [legacy] })?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "unknown" }] })
    expect(project(valid, { taskGraphTemplateRoles: { scout: "analyst" } })?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "unknown" }] })
    expect(project(valid, { taskGraphTemplateRoles: {} })?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "unknown" }] })
  })

  it("returns unknown when the selected typed report is malformed", () => {
    const valid = current([node({ status: "completed", report: "passed" })])
    const observation = valid.toolObservations[0]!
    const content = observation.content as { nodes: Array<Record<string, unknown>> }
    const malformedNode = { ...content.nodes[0], verificationReport: { status: "passed", criteria: [] } }
    const malformed = { ...observation, content: { ...content, nodes: [malformedNode] } }
    expect(project(valid, { observations: [malformed] })?.content)
      .toMatchObject({ requirements: [{ id: requirementId, status: "unknown" }] })
  })

  it("uses unknown for missing, stale, ambiguous, and malformed current graph observations", () => {
    const valid = current([node({ status: "completed", report: "passed" })])
    const graph = valid.toolObservations[0]!
    expect(taskGraphObjectiveProgressObservation({ resolution, observations: [], taskGraphRevision: 7, rootTaskId })?.content)
      .toMatchObject({ revision: null, requirements: [{ status: "unknown" }] })
    expect(project(valid, { taskGraphRevision: 8 })?.content).toMatchObject({ revision: null, requirements: [{ status: "unknown" }] })
    expect(taskGraphObjectiveProgressObservation({ resolution, observations: [graph, graph], taskGraphRevision: 7, rootTaskId })?.content)
      .toMatchObject({ revision: null, requirements: [{ status: "unknown" }] })
    const malformed = { ...graph, content: { ...(graph.content as Record<string, unknown>), revision: 8 } }
    expect(taskGraphObjectiveProgressObservation({ resolution, observations: [malformed], taskGraphRevision: 7, rootTaskId })?.content)
      .toMatchObject({ revision: null, requirements: [{ status: "unknown" }] })
  })

  it("omits absent or invalid requirements and keeps the packet bounded and private", () => {
    expect(taskGraphObjectiveProgressObservation({ resolution: { status: "absent" }, observations: [], rootTaskId })).toBeUndefined()
    expect(taskGraphObjectiveProgressObservation({ resolution: { status: "invalid" }, observations: [], rootTaskId })).toBeUndefined()
    const projected = project(current([node({ status: "completed", report: "passed" })]))!
    const encoded = JSON.stringify(projected.content)
    expect(projected.id).toBe(TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID)
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(4 * 1024)
    expect(encoded).toContain('"advisory":true')
    for (const privateValue of ["PRIVATE_NODE_GOAL", "PRIVATE_RESULT_SUMMARY", "scout-task", "evidenceDigest", "resultDigest", "criteria_met"]) {
      expect(encoded).not.toContain(privateValue)
    }
    expect(projected.content).toEqual({
      schemaVersion: "agent-harness.v2.objective-progress.v1", advisory: true, revision: 7,
      requirements: [{ ...requirement, status: "reported_passed" }],
    })

    const manyRequirements = resolveRootTaskVerificationRequirements({ input: { verificationRequirements: {
      schemaVersion: "agent-harness.v2.objective-requirements.v1",
      requirements: Array.from({ length: 8 }, (_, index) => ({ id: `candidate-${index}`, check: { kind: "candidate_count_gte", minimum: index + 1 } })),
    } } })
    const bounded = taskGraphObjectiveProgressObservation({ resolution: manyRequirements, observations: current([]).toolObservations,
      taskGraphRevision: 7, rootTaskId })!
    expect((bounded.content as { requirements: unknown[] }).requirements).toHaveLength(8)
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(4 * 1024)
  })
})
