import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION } from "./child-discovery-attempt.js"
import { DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION } from "./child-discovery-query-footprint.js"
import { DISCOVERY_RECOVERY_SCHEMA_VERSION } from "./task-graph-discovery-recovery-contract.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport, TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION } from "./task-graph-command-port.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { currentTaskGraph } from "./task-graph-pg-current-node.js"
import { projectTaskGraphResult, TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT } from "./task-graph-result-projection.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot, taskGraphState } from "./task-graph-snapshot.js"

const candidateJobId = "c000000000000000000000001"
const footprint = {
  schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, availability: "available",
  calls: [{ criteria: { targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], hasCursor: false },
    outcome: "completed", requestCount: 1, observedCandidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false }],
} as const
const health = {
  schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION, attemptedCalls: 1, completedCalls: 1, failedCalls: 0,
  unresolvedCalls: 0, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false,
} as const
const verification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
} as const
const analystVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const
const scoutEnvelope = {
  role: TASK_GRAPH_TEMPLATES.scout.role, taskType: TASK_GRAPH_TEMPLATES.scout.taskType,
  expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema,
  allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions],
}
const report = {
  verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
  criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }],
  evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64),
}
const failedReport = {
  verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
  criteria: [{ criterionId: "candidate-count", status: "failed", reasonCode: "criterion_not_met" }],
  evidenceDigest: "c".repeat(64), resultDigest: "d".repeat(64),
}
const scoutResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [{ jobId: candidateJobId, source: "greenhouse", url: null, evidenceIds: ["evidence-1"] }],
  evidence: [{ id: "evidence-1", kind: "job", ref: candidateJobId, source: "greenhouse" }],
  summary: "Found one role",
} as const
const canonicalScoutEnvelope = {
  finalItemId: "final-1", finalText: JSON.stringify(scoutResult), status: "completed",
  stepCount: 1, structuredResult: scoutResult, toolCallCount: 1,
}
const recovery = {
  schemaVersion: DISCOVERY_RECOVERY_SCHEMA_VERSION, attemptCount: 1, jobIds: [candidateJobId], truncated: false,
} as const
const validScoutResultWithSidecars: Record<string, unknown> = {
  ...canonicalScoutEnvelope, taskGraphVerificationReport: report,
  discoveryAttempt: attemptSidecar(), discoveryRecovery: recovery,
}

type FixtureOptions = Partial<{
  turn: "ordinary" | "scheduled" | "unknown"
  attemptCount: number
  role: string
  taskType: string
  expectedOutputSchema: unknown
  allowedActions: unknown
  contextIsObject: boolean
  hasPrivateSelectionContext: boolean
  registeredScoutEnvelope: unknown
  includeAttempt: boolean
  includeRecovery: boolean
  discoveryAttempt: unknown
  discoveryRecovery: unknown
  result: unknown
}>

function attemptSidecar(attemptCount = 1) {
  return { attemptCount, health, queryFootprint: footprint }
}

function completedScoutResult(options: FixtureOptions = {}): unknown {
  if (Object.hasOwn(options, "result")) return options.result
  const attempt = Object.hasOwn(options, "discoveryAttempt") ? options.discoveryAttempt : attemptSidecar(options.attemptCount)
  const recoverySidecar = Object.hasOwn(options, "discoveryRecovery") ? options.discoveryRecovery : recovery
  return {
    ...canonicalScoutEnvelope,
    taskGraphVerificationReport: report,
    ...(options.includeAttempt === false ? {} : { discoveryAttempt: attempt }),
    ...(options.includeRecovery === false ? {} : { discoveryRecovery: recoverySidecar }),
  }
}

function loaded(options: FixtureOptions = {}): LoadedGraph {
  const taskId = "child-1", attemptCount = options.attemptCount ?? 1
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
    key: "scout", templateId: "scout", goal: "Find current roles", successCriteria: ["Return candidates"],
    dependsOn: [], depth: 1, taskId, verification, verificationDisposition: "typed",
    registeredScoutEnvelope: Object.hasOwn(options, "registeredScoutEnvelope") ? options.registeredScoutEnvelope : scoutEnvelope,
  }] })
  const task: GraphTaskRow = {
    id: taskId, status: "completed", role: options.role ?? "scout", taskType: options.taskType ?? "job_discovery",
    expectedOutputSchema: options.expectedOutputSchema ?? TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema,
    allowedActions: Object.hasOwn(options, "allowedActions") ? options.allowedActions : TASK_GRAPH_TEMPLATES.scout.allowedActions,
    contextIsObject: options.contextIsObject ?? true,
    hasPrivateSelectionContext: options.hasPrivateSelectionContext ?? false,
    attemptCount, failureReason: null, result: completedScoutResult(options),
  }
  const state = taskGraphState(snapshot, 2, new Map([[taskId, { status: task.status, failureReason: task.failureReason }]]), [])
  return { rootTaskId: "root-1", snapshot, item: { id: "task_graph:root-1", revision: 2, content: snapshot, createdAt: new Date(0) },
    state, tasks: new Map([[taskId, task]]), discoveryTurnEligibility: options.turn ?? "ordinary" }
}

type RepairFixtureOptions = Partial<{
  attemptCount: number
  includeAttempt: boolean
  discoveryAttempt: unknown
  includeRecovery: boolean
  discoveryRecovery: unknown
  report: unknown
  includeReceipt: boolean
  receipt: unknown
  repairRootTaskId: string
  repairTargetNodeKey: string
  repairTargetTaskId: string
  repairCriterionIds: readonly string[]
  taskRole: string
  taskType: string
  extraResult: Readonly<Record<string, unknown>>
}>

function loadedRepair(options: RepairFixtureOptions = {}): LoadedGraph {
  const repairOf = { graphRootTaskId: options.repairRootTaskId ?? "root-1", nodeKey: options.repairTargetNodeKey ?? "target",
    taskId: options.repairTargetTaskId ?? "target-task", criterionIds: [...(options.repairCriterionIds ?? ["candidate-count"])] }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
    { key: "target", templateId: "scout", goal: "Find candidates", successCriteria: ["Return candidates"], dependsOn: [], depth: 1,
      taskId: "target-task", verification, verificationDisposition: "typed", registeredScoutEnvelope: scoutEnvelope },
    { key: "repair", templateId: "scout", goal: "Repair candidate discovery", successCriteria: ["Return candidates"], dependsOn: [], depth: 1,
      taskId: "repair-task", verification, verificationDisposition: "typed", repairOf, registeredScoutEnvelope: scoutEnvelope },
  ] })
  const repairReport = Object.hasOwn(options, "report") ? options.report : report
  const repairReceipt = Object.hasOwn(options, "receipt") ? options.receipt : {
    schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: repairOf.graphRootTaskId,
    targetNodeKey: repairOf.nodeKey, targetTaskId: repairOf.taskId, criterionIds: repairOf.criterionIds,
    repairNodeKey: "repair", repairTaskId: "repair-task", verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: report.evidenceDigest,
  }
  const target: GraphTaskRow = { id: "target-task", status: "failed", role: "scout", taskType: "job_discovery",
    expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema, allowedActions: TASK_GRAPH_TEMPLATES.scout.allowedActions,
    attemptCount: 1, failureReason: null, result: { status: "failed", taskGraphVerificationReport: failedReport } }
  const attemptCount = options.attemptCount ?? 2
  const repair: GraphTaskRow = { id: "repair-task", status: "completed", role: options.taskRole ?? "scout", taskType: options.taskType ?? "job_discovery",
    expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema, allowedActions: TASK_GRAPH_TEMPLATES.scout.allowedActions,
    contextIsObject: true, hasPrivateSelectionContext: false,
    attemptCount, failureReason: null, result: { ...canonicalScoutEnvelope, ...options.extraResult, taskGraphVerificationReport: repairReport,
      ...(options.includeReceipt === false ? {} : { taskGraphRepairReceipt: repairReceipt }),
      ...(options.includeAttempt ? { discoveryAttempt: Object.hasOwn(options, "discoveryAttempt") ? options.discoveryAttempt : attemptSidecar(attemptCount) } : {}),
      ...(options.includeRecovery ? { discoveryRecovery: Object.hasOwn(options, "discoveryRecovery") ? options.discoveryRecovery : recovery } : {}) } }
  const tasks = new Map([[target.id, target], [repair.id, repair]])
  const state = taskGraphState(snapshot, 2, new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }])), [])
  return { rootTaskId: "root-1", snapshot, item: { id: "task_graph:root-1", revision: 2, content: snapshot, createdAt: new Date(0) }, state, tasks }
}

function loadedAnalyst(): LoadedGraph {
  const result = { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [], evidence: [], summary: "No findings" }
  const envelope = { finalItemId: "final-analyst", finalText: JSON.stringify(result), status: "completed", stepCount: 1, structuredResult: result, toolCallCount: 1,
    taskGraphVerificationReport: { ...report, criteria: [{ criterionId: "finding-count", status: "passed", reasonCode: "criteria_met" }] } }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
    key: "analyst", templateId: "analyst", goal: "Analyze findings", successCriteria: ["Return findings"], dependsOn: [], depth: 1,
    taskId: "analyst-task", verification: analystVerification, verificationDisposition: "typed",
  }] })
  const task: GraphTaskRow = { id: "analyst-task", status: "completed", role: "analyst", taskType: "job_analysis",
    expectedOutputSchema: TASK_GRAPH_TEMPLATES.analyst.expectedOutputSchema, allowedActions: TASK_GRAPH_TEMPLATES.analyst.allowedActions,
    attemptCount: 1, failureReason: null, result: envelope }
  const state = taskGraphState(snapshot, 2, new Map([[task.id, { status: task.status, failureReason: task.failureReason }]]), [])
  return { rootTaskId: "root-1", snapshot, item: { id: "task_graph:root-1", revision: 2, content: snapshot, createdAt: new Date(0) },
    state, tasks: new Map([[task.id, task]]) }
}

describe("current TaskGraph query footprint projection", () => {
  it("keeps query footprints limited to ordinary Turns while retaining generic health observations", () => {
    const ordinary = currentTaskGraph(loaded({ turn: "ordinary" }))
    expect(ordinary.discoveryTurnEligibility).toBe("ordinary")
    expect(ordinary.nodes[0]?.discoveryQueryFootprint).toEqual(footprint)
    for (const turn of ["scheduled", "unknown"] as const) {
      const projected = currentTaskGraph(loaded({ turn }))
      expect(projected).not.toHaveProperty("discoveryTurnEligibility")
      expect(projected.nodes[0]).not.toHaveProperty("discoveryQueryFootprint")
      expect(projected.nodes[0]?.discoveryAttemptHealth).toEqual(health)
    }
  })

  it("preserves the valid completed Scout projection after validating its independent sidecars", () => {
    const graph = currentTaskGraph(loaded())
    const node = graph.nodes[0]!

    expect(node.resultProjection).toEqual(projectTaskGraphResult("scout", "completed", canonicalScoutEnvelope))
    expect(node.discoveryAttemptHealth).toEqual(health)
    expect(node.discoveryQueryFootprint).toEqual(footprint)
    expect(node.verificationReport).toEqual(report)
    expect(graph.discoveryTurnEligibility).toBe("ordinary")
  })

  it("omits an attempt footprint from a mismatched persisted attempt", () => {
    const node = currentTaskGraph(loaded({ attemptCount: 2, discoveryAttempt: attemptSidecar(1) })).nodes[0]!
    expect(node.resultProjection?.availability).toBe("unavailable")
    expect(node).not.toHaveProperty("discoveryAttemptHealth")
    expect(node).not.toHaveProperty("discoveryQueryFootprint")
  })

  it("validates recovery metadata independently and strips only its exact current-attempt shape", () => {
    const withoutAttempt = currentTaskGraph(loaded({ includeAttempt: false })).nodes[0]!
    expect(withoutAttempt.resultProjection).toEqual(projectTaskGraphResult("scout", "completed", canonicalScoutEnvelope))
    expect(withoutAttempt).not.toHaveProperty("discoveryAttemptHealth")

    for (const invalid of [
      { ...recovery, attemptCount: 2 },
      { ...recovery, jobIds: ["not-a-canonical-job-id"] },
      { ...recovery, unexpected: "extra" },
    ]) {
      expect(currentTaskGraph(loaded({ discoveryRecovery: invalid })).nodes[0]?.resultProjection?.availability).toBe("unavailable")
    }
  })

  it("keeps malformed, conflicting, out-of-scope and unknown discovery metadata unavailable", () => {
    const invalid = [
      loaded({ discoveryAttempt: { ...attemptSidecar(), attemptCount: 2 } }),
      loaded({ discoveryAttempt: { ...attemptSidecar(), unexpected: true } }),
      loaded({ discoveryAttempt: { ...attemptSidecar(), queryFootprint: { ...footprint, unexpected: true } } }),
      loaded({ discoveryRecovery: { ...recovery, attemptCount: 2 } }),
      loaded({ discoveryRecovery: { ...recovery, unexpected: true } }),
      loaded({ role: "analyst" }), loaded({ taskType: "private_research" }),
      loaded({ allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions, "private.tool"] }),
      loaded({ contextIsObject: false }), loaded({ hasPrivateSelectionContext: true }),
      loaded({ registeredScoutEnvelope: { ...scoutEnvelope, taskType: "private_research" } }),
      loaded({ result: { ...validScoutResultWithSidecars, unknownMetadata: true } }),
      loaded({ result: { ...validScoutResultWithSidecars, structuredResult: { ...scoutResult, privateField: true } } }),
    ]
    for (const graph of invalid) expect(currentTaskGraph(graph).nodes[0]?.resultProjection?.availability).toBe("unavailable")
  })

  it("preserves the existing health and footprint outputs when new projection stripping is inapplicable", () => {
    const node = currentTaskGraph(loaded({ contextIsObject: false })).nodes[0]!
    expect(node.resultProjection?.availability).toBe("unavailable")
    expect(node.discoveryAttemptHealth).toEqual(health)
    expect(node.discoveryQueryFootprint).toEqual(footprint)
  })

  it("preserves validated verification and repair provenance and current node order", () => {
    const fixture = loadedRepair()
    const repairNode = fixture.snapshot!.nodes[1]!
    const repairTask = fixture.tasks.get(repairNode.taskId)!
    const repairResult = repairTask.result as Record<string, unknown>
    const parsedReport = parseTaskGraphVerificationReport(repairResult.taskGraphVerificationReport, ["candidate-count"])
    expect(parsedReport).toEqual(report)
    expect(parseTaskGraphRepairReceipt(repairResult.taskGraphRepairReceipt, {
      repairOf: repairNode.repairOf, repairNodeKey: repairNode.key, repairTaskId: repairNode.taskId, report: parsedReport,
    })).toBeDefined()
    const graph = currentTaskGraph(fixture)
    expect(graph.nodes.map(node => node.key)).toEqual(["target", "repair"])
    expect(graph.nodes[0]?.verificationReport).toEqual(failedReport)
    expect(graph.nodes[1]).toMatchObject({ repairOf: { nodeKey: "target", taskId: "target-task" }, verificationReport: report })
    expect(graph.nodes[1]?.repairReceipt).toMatchObject({ repairTaskId: "repair-task", evidenceDigest: report.evidenceDigest })
    expect(graph.nodes[1]?.resultProjection).toEqual(projectTaskGraphResult("scout", "completed", canonicalScoutEnvelope))
    expect(graph.nodes[1]).not.toHaveProperty("discoveryAttemptHealth")
    expect(graph.nodes[1]).not.toHaveProperty("discoveryQueryFootprint")
  })

  it("projects a repaired Scout with its exact current discovery attempt and repair receipt", () => {
    const graph = currentTaskGraph(loadedRepair({ includeAttempt: true }))
    const node = graph.nodes[1]!

    expect(node.resultProjection).toEqual(projectTaskGraphResult("scout", "completed", canonicalScoutEnvelope))
    expect(node).toMatchObject({
      repairOf: { graphRootTaskId: "root-1", nodeKey: "target", taskId: "target-task", criterionIds: ["candidate-count"] },
      verificationReport: report,
      repairReceipt: { graphRootTaskId: "root-1", targetTaskId: "target-task", repairTaskId: "repair-task", evidenceDigest: report.evidenceDigest },
    })
    expect(graph.nodes.map(item => item.key)).toEqual(["target", "repair"])
    expect(node).not.toHaveProperty("discoveryAttemptHealth")
    expect(node).not.toHaveProperty("discoveryQueryFootprint")
  })

  it("keeps repaired results unavailable for stale or malformed attempts and any recovery sidecar", () => {
    const invalid = [
      loadedRepair({ includeAttempt: true, discoveryAttempt: attemptSidecar(1) }),
      loadedRepair({ includeAttempt: true, discoveryAttempt: { ...attemptSidecar(2), unknown: true } }),
      loadedRepair({ includeAttempt: true, discoveryAttempt: { ...attemptSidecar(2), health: { ...health, unknown: true } } }),
      loadedRepair({ includeAttempt: true, discoveryAttempt: { ...attemptSidecar(2), queryFootprint: { ...footprint, unknown: true } } }),
      loadedRepair({ includeAttempt: true, includeRecovery: true }),
      loadedRepair({ includeAttempt: true, includeRecovery: true, discoveryRecovery: { ...recovery, unknown: true } }),
      loadedRepair({ includeAttempt: true, extraResult: { unknownMetadata: true } }),
      loadedRepair({ includeAttempt: true, taskRole: "analyst" }),
      loadedRepair({ includeAttempt: true, taskType: "private_research" }),
    ]
    for (const fixture of invalid) {
      expect(currentTaskGraph(fixture).nodes[1]?.resultProjection?.availability).toBe("unavailable")
      expect(currentTaskGraph(fixture).nodes[1]).not.toHaveProperty("discoveryAttemptHealth")
      expect(currentTaskGraph(fixture).nodes[1]).not.toHaveProperty("discoveryQueryFootprint")
    }
  })

  it("keeps a repair result fail-closed when its persisted repair proof drifts", () => {
    const base = loadedRepair()
    const receipt = (base.tasks.get("repair-task")!.result as Record<string, unknown>).taskGraphRepairReceipt as Record<string, unknown>
    const missingReceipt = loadedRepair({ includeReceipt: false })
    const missingReport = loadedRepair({ report: undefined })
    const malformedReport = loadedRepair({ report: { ...report, unknown: true } })
    const mismatchedEvidence = loadedRepair({ report: { ...report, evidenceDigest: "c".repeat(64) } })
    const forgedReceipts = [
      { ...receipt, graphRootTaskId: "foreign-root" },
      { ...receipt, targetNodeKey: "foreign-target-node" },
      { ...receipt, targetTaskId: "foreign-target-task" },
      { ...receipt, criterionIds: ["foreign-criterion"] },
      { ...receipt, repairNodeKey: "foreign-repair-node" },
      { ...receipt, repairTaskId: "foreign-repair-task" },
      { ...receipt, evidenceDigest: "c".repeat(64) },
    ]

    expect(() => currentTaskGraph(missingReceipt)).toThrow("task_graph_verification_report_invalid")
    expect(() => currentTaskGraph(missingReport)).toThrow("task_graph_verification_report_invalid")
    expect(() => currentTaskGraph(malformedReport)).toThrow("task_graph_verification_report_invalid")
    expect(() => currentTaskGraph(mismatchedEvidence)).toThrow("task_graph_verification_report_invalid")
    for (const forged of forgedReceipts) {
      expect(() => currentTaskGraph(loadedRepair({ receipt: forged }))).toThrow("task_graph_verification_report_invalid")
    }
    expect(() => currentTaskGraph(loadedRepair({ repairRootTaskId: "foreign-root" })))
      .toThrow("task_graph_verification_report_invalid")
    expect(() => currentTaskGraph(loadedRepair({ repairTargetTaskId: "foreign-target-task" })))
      .toThrow("task_graph_snapshot_repair_invalid")
  })

  it("preserves the source envelope byte bound while removing verified metadata", () => {
    const serialized = JSON.stringify(validScoutResultWithSidecars)
    const oversized = `${serialized.slice(0, 1)}${" ".repeat(TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT)}${serialized.slice(1)}`
    const node = currentTaskGraph(loaded({ result: oversized })).nodes[0]!
    expect(node.resultProjection?.availability).toBe("unavailable")
  })

  it("keeps malformed verification sidecars on the existing fail-closed path", () => {
    const malformedReport = { ...report, unexpected: "extra" }
    const malformed = loaded({ result: { ...validScoutResultWithSidecars, taskGraphVerificationReport: malformedReport } })
    expect(() => currentTaskGraph(malformed)).toThrow("task_graph_verification_report_invalid")

    const malformedReceipt = loaded({ result: { ...validScoutResultWithSidecars, taskGraphRepairReceipt: { unexpected: true } } })
    expect(() => currentTaskGraph(malformedReceipt)).toThrow("task_graph_verification_report_invalid")
  })

  it("leaves the existing non-Scout role projection unchanged", () => {
    const node = currentTaskGraph(loadedAnalyst()).nodes[0]!
    expect(node.resultProjection).toEqual(projectTaskGraphResult("analyst", "completed", {
      finalItemId: "final-analyst", finalText: JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [], evidence: [], summary: "No findings" }),
      status: "completed", stepCount: 1,
      structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [], evidence: [], summary: "No findings" },
      toolCallCount: 1,
    }))
  })
})
