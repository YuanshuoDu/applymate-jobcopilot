import { describe, expect, it } from "vitest"
import { deriveRootTaskHistoryLessonFacts, filterRootTaskHistoryLessonsForEmittedNodes, parseRootTaskHistoryNodeLesson,
  projectLoadedRootTaskHistoryGraph, sanitizeRootTaskHistoryNodeLessonForCrossSession } from "./root-task-history-lesson-projection.js"
import { currentTaskGraph, type GraphTaskRow, type LoadedGraph } from "../subagents/task-graph-pg-state.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphState, type StoredTaskGraphNode, type TaskGraphSnapshot } from "../subagents/task-graph-snapshot.js"
import { TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION } from "../subagents/task-graph-command-port.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-pg-verification.js"
import { resolveTaskGraphRepairDependencies } from "../subagents/task-graph-dependency-context.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION, TASK_GRAPH_NATIVE_TEMPLATE_ID } from "../subagents/task-graph-native-state.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"

const ROOT = "private-root-id"
const CRITERIA = [
  { id: "first-count", check: { kind: "candidate_count_gte", minimum: 2 } },
  { id: "second-count", check: { kind: "candidate_count_gte", minimum: 3 } },
] as const
const CONTRACT = { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "scout", criteria: CRITERIA } as const
const DIGEST = "a".repeat(64)

function report(status: "failed" | "passed" | "unverified", ids: readonly string[] = CRITERIA.map(item => item.id),
  statuses?: readonly ("failed" | "passed" | "unverified")[]) {
  const criteria = ids.map((criterionId, index) => {
    const criterionStatus = statuses?.[index] ?? status
    const reasonCode = criterionStatus === "passed" ? "criteria_met" : criterionStatus === "failed" ? "criterion_not_met" : "canonical_evidence_missing"
    return { criterionId, status: criterionStatus, reasonCode }
  })
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status,
    reasonCode: status === "passed" ? "criteria_met" : status === "failed" ? "criterion_not_met" : "canonical_evidence_missing",
    criteria, evidenceDigest: DIGEST, resultDigest: DIGEST }
}
function snapshotWith(repairCount: number, targetStatuses?: readonly ("failed" | "passed")[]): TaskGraphSnapshot {
  const target = { key: "source-node-private", templateId: "scout", goal: "source private goal", successCriteria: ["private requirement"],
    dependsOn: [], depth: 1, taskId: "source-task-private", verificationDisposition: "typed", verification: CONTRACT }
  const repairNodes = Array.from({ length: repairCount }, (_, index) => {
    const key = `repair-node-${index + 1}`, taskId = `repair-task-${index + 1}`
    return { key, templateId: "scout", goal: "repair private goal", successCriteria: ["private repair requirement"], dependsOn: [], depth: 2,
      taskId, verificationDisposition: "typed", verification: CONTRACT,
      repairOf: { graphRootTaskId: ROOT, nodeKey: target.key, taskId: target.taskId, criterionIds: CRITERIA.map(item => item.id) } }
  })
  return parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [target, ...repairNodes] })
}
function fixture(options: { repairCount?: number; targetStatuses?: readonly ("failed" | "passed")[]; repairStatus?: "failed" | "completed";
  repairReportStatus?: "failed" | "passed" | "unverified" } = {}) {
  const repairCount = options.repairCount ?? 1, snapshot = snapshotWith(repairCount, options.targetStatuses)
  const tasks = new Map<string, GraphTaskRow>()
  tasks.set("source-task-private", { id: "source-task-private", status: "failed", role: "scout", failureReason: "task_graph_verification_failed",
    result: { taskGraphVerificationReport: report("failed", undefined, options.targetStatuses) } })
  for (let index = 0; index < repairCount; index++) {
    const node = snapshot.nodes[index + 1]!, repairStatus = options.repairStatus ?? "completed"
    const taskReport = report(options.repairReportStatus ?? (repairStatus === "completed" ? "passed" : "failed"))
    const receipt = { schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: ROOT, targetNodeKey: snapshot.nodes[0]!.key,
      targetTaskId: snapshot.nodes[0]!.taskId, criterionIds: CRITERIA.map(item => item.id), repairNodeKey: node.key,
      repairTaskId: node.taskId, verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: taskReport.evidenceDigest }
    tasks.set(node.taskId, { id: node.taskId, status: repairStatus, role: "scout",
      failureReason: repairStatus === "failed" ? "task_graph_verification_failed" : null,
      result: { taskGraphVerificationReport: taskReport, ...(repairStatus === "completed" ? { taskGraphRepairReceipt: receipt } : {}) } })
  }
  const statuses = new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }] as const))
  const base = taskGraphState(snapshot, 7, statuses, [])
  const coverage = resolveTaskGraphRepairDependencies(snapshot, tasks, ROOT)
  const state = { ...base, repairSatisfiedNodeKeys: coverage.satisfied, repairPendingNodeKeys: coverage.pending }
  const loaded: LoadedGraph = { rootTaskId: ROOT, snapshot, state, tasks, item: { id: "private-item", revision: 7, content: snapshot, createdAt: new Date(0) } }
  return { loaded, graph: currentTaskGraph(loaded) }
}

function executionFailureFixture(reason: string, status: "failed" | "running" = "failed", native = false) {
  const taskId = "failure-task-private", templateId = native ? TASK_GRAPH_NATIVE_TEMPLATE_ID : "scout"
  const node = { key: "failure-node-private", templateId, goal: "private failure goal", successCriteria: ["private criterion"], dependsOn: [], depth: 1,
    taskId, verificationDisposition: "legacy_unverified",
    ...(native ? { nativeDelegation: { schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: "private-operation",
      requestFingerprint: "b".repeat(64), callerTaskId: ROOT, role: "scout", taskType: "native-task", contextDigest: "c".repeat(64), contextBytes: 1 } } : {}) }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [node] })
  const task: GraphTaskRow = { id: taskId, status, role: "scout", ...(native ? { taskType: "native-task" } : {}), failureReason: reason,
    result: { summary: "private result prose", errorCode: "private error code" } }
  const tasks = new Map([[taskId, task]]), state = taskGraphState(snapshot, 7,
    new Map([[taskId, { status, failureReason: reason }]]), [])
  const loaded: LoadedGraph = { rootTaskId: ROOT, snapshot, state, tasks,
    item: { id: "failure-item-private", revision: 7, content: snapshot, createdAt: new Date(0) } }
  return { loaded, graph: currentTaskGraph(loaded), task }
}

function overlappingCoverageFixture() {
  const criteria = [...CRITERIA, { id: "third-count", check: { kind: "candidate_count_gte" as const, minimum: 4 } }] as const
  const target = { key: "source-node-private", templateId: "scout", goal: "source private goal", successCriteria: ["private requirement"],
    dependsOn: [], depth: 1, taskId: "source-task-private", verificationDisposition: "typed", verification: { ...CONTRACT, criteria } }
  const repairCriterionIds = [["first-count", "second-count"], ["second-count", "third-count"]] as const
  const repairs = repairCriterionIds.map((criterionIds, index) => {
    const key = `repair-node-${index + 1}`, taskId = `repair-task-${index + 1}`
    return { key, templateId: "scout", goal: "repair private goal", successCriteria: ["private repair requirement"], dependsOn: [], depth: 2,
      taskId, verificationDisposition: "typed", verification: { ...CONTRACT, criteria: criterionIds.map(id => criteria.find(item => item.id === id)!) },
      repairOf: { graphRootTaskId: ROOT, nodeKey: target.key, taskId: target.taskId, criterionIds: [...criterionIds] } }
  })
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [target, ...repairs] })
  const tasks = new Map<string, GraphTaskRow>()
  tasks.set(target.taskId, { id: target.taskId, status: "failed", role: "scout", failureReason: "task_graph_verification_failed",
    result: { taskGraphVerificationReport: report("failed", criteria.map(item => item.id)) } })
  for (let index = 0; index < repairs.length; index++) {
    const node = snapshot.nodes[index + 1]!, criterionIds = repairCriterionIds[index]!, taskReport = report("passed", [...criterionIds])
    const receipt = { schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: ROOT, targetNodeKey: target.key,
      targetTaskId: target.taskId, criterionIds: [...criterionIds], repairNodeKey: node.key, repairTaskId: node.taskId,
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: taskReport.evidenceDigest }
    tasks.set(node.taskId, { id: node.taskId, status: "completed", role: "scout", failureReason: null,
      result: { taskGraphVerificationReport: taskReport, taskGraphRepairReceipt: receipt } })
  }
  const statuses = new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }] as const))
  const base = taskGraphState(snapshot, 7, statuses, []), coverage = resolveTaskGraphRepairDependencies(snapshot, tasks, ROOT)
  const state = { ...base, repairSatisfiedNodeKeys: coverage.satisfied, repairPendingNodeKeys: coverage.pending }
  const loaded: LoadedGraph = { rootTaskId: ROOT, snapshot, state, tasks,
    item: { id: "private-item", revision: 7, content: snapshot, createdAt: new Date(0) } }
  return { loaded, graph: currentTaskGraph(loaded), targetKey: target.key }
}

function reportedOutputFixture(): LoadedGraph {
  const { loaded } = fixture({ repairCount: 0 }), node = loaded.snapshot!.nodes[0]!
  const candidates = Array.from({ length: 5 }, (_, index) => ({ jobId: `job-${index + 1}`, source: "greenhouse",
    url: `https://private.example/${index}`, evidenceIds: [`evidence-${index + 1}`] }))
  const structuredResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "partial", candidates,
    evidence: candidates.map(candidate => ({ id: candidate.evidenceIds[0], kind: "job", ref: candidate.jobId, source: "private source" })),
    summary: "private summary" }
  const task = loaded.tasks.get(node.taskId)!, taskReport = report("passed")
  const result = { finalItemId: "private-final-id", finalText: "private text", status: "completed", stepCount: 1,
    structuredResult, toolCallCount: 1, taskGraphVerificationReport: taskReport }
  const tasks = new Map(loaded.tasks).set(node.taskId, { ...task, status: "completed", failureReason: null, result })
  const statuses = new Map([...tasks].map(([id, row]) => [id, { status: row.status, failureReason: row.failureReason }] as const))
  const state = taskGraphState(loaded.snapshot!, 7, statuses, [])
  return { ...loaded, tasks, state: { ...state, repairSatisfiedNodeKeys: [], repairPendingNodeKeys: [] } }
}

describe("root history ordinal lessons", () => {
  it("projects only a failed coverage check and its source-local Scout ordinal", () => {
    const coverageSnapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
      { key: "scout-private-key", templateId: "scout", goal: "private source goal", successCriteria: ["find"], dependsOn: [], depth: 1,
        taskId: "scout-private-task", verificationDisposition: "typed", verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1",
          role: "scout", criteria: [{ id: "scout-count", check: { kind: "candidate_count_gte", minimum: 1 } }] } },
      { key: "analyst-private-key", templateId: "analyst", goal: "private analysis goal", successCriteria: ["cover"], dependsOn: ["scout-private-key"], depth: 2,
        taskId: "analyst-private-task", verificationDisposition: "typed", verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1",
          role: "analyst", criteria: [{ id: "coverage-private-id", check: { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout-private-key", minimumPercent: 75 } }] } },
    ] })
    const makeReport = (criterionId: string, status: "passed" | "failed") => ({ verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
      status, reasonCode: status === "passed" ? "criteria_met" : "criterion_not_met",
      criteria: [{ criterionId, status, reasonCode: status === "passed" ? "criteria_met" : "criterion_not_met" }],
      evidenceDigest: DIGEST, resultDigest: DIGEST })
    const tasks = new Map<string, GraphTaskRow>([
      ["scout-private-task", { id: "scout-private-task", status: "completed", role: "scout", failureReason: null,
        result: { taskGraphVerificationReport: makeReport("scout-count", "passed") } }],
      ["analyst-private-task", { id: "analyst-private-task", status: "failed", role: "analyst", failureReason: "task_graph_verification_failed",
        result: { taskGraphVerificationReport: makeReport("coverage-private-id", "failed") } }],
    ])
    const statuses = new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }] as const))
    const base = taskGraphState(coverageSnapshot, 9, statuses, [])
    const loaded: LoadedGraph = { rootTaskId: ROOT, snapshot: coverageSnapshot, state: { ...base, repairSatisfiedNodeKeys: [], repairPendingNodeKeys: [] },
      tasks, item: { id: "coverage-private-item", revision: 9, content: coverageSnapshot, createdAt: new Date(0) } }
    const projected = projectLoadedRootTaskHistoryGraph(loaded)
    const descriptor = projected?.nodeLessons?.[1]?.criterionFailures[0]?.check
    expect(projected?.sourceNodeOrdinals).toEqual([1, 2])
    expect(descriptor).toEqual({ role: "analyst", kind: "findings_cover_scout_candidates_gte", dependencyNodeOrdinal: 1, minimumPercent: 75 })
    const serialized = JSON.stringify(projected?.nodeLessons)
    for (const secret of ["scout-private-key", "scout-private-task", "analyst-private-key", "analyst-private-task", "coverage-private-id", "private analysis goal"]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("projects only the three exact ordinary execution categories from aligned failed task rows", () => {
    const cases = [
      ["child_turn_missing", "execution_setup_unavailable"],
      ["child_resume_unavailable", "resume_state_unavailable"],
      ["invalid_structured_result", "structured_output_invalid"],
    ] as const
    for (const [reason, category] of cases) {
      const { loaded } = executionFailureFixture(reason)
      const expected = [{ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
        criterionFailures: [], executionFailureCategory: category }]
      expect(deriveRootTaskHistoryLessonFacts(loaded, currentTaskGraph(loaded))).toEqual(expected)
      expect(projectLoadedRootTaskHistoryGraph(loaded)?.nodeLessons).toEqual(expected)
      const safeLesson = JSON.stringify(expected)
      for (const privateValue of [reason, "failure-task-private", "failure-node-private", ROOT, "private failure goal", "private result prose", "private error code"]) {
        expect(safeLesson).not.toContain(privateValue)
      }
    }
  })

  it("omits categories for nonfailed, report-backed, native, forged, mismatched, or accessor task facts", () => {
    const ordinary = executionFailureFixture("child_turn_missing")
    const running = executionFailureFixture("child_turn_missing", "running")
    expect(deriveRootTaskHistoryLessonFacts(running.loaded, running.graph)).toEqual([undefined])
    expect(deriveRootTaskHistoryLessonFacts(ordinary.loaded,
      running.graph)).toEqual([])

    const typed = fixture({ repairCount: 0 }), typedNode = typed.loaded.snapshot!.nodes[0]!
    const typedTask = typed.loaded.tasks.get(typedNode.taskId)!
    const typedTasks = new Map(typed.loaded.tasks).set(typedNode.taskId, { ...typedTask, failureReason: "child_turn_missing" })
    const typedState = taskGraphState(typed.loaded.snapshot!, 7,
      new Map([[typedNode.taskId, { status: "failed", failureReason: "child_turn_missing" }]]), [])
    const reportBacked = { ...typed.loaded, tasks: typedTasks, state: typedState }
    const reportLessons = deriveRootTaskHistoryLessonFacts(reportBacked, currentTaskGraph(reportBacked))
    expect(reportLessons[0]?.executionFailureCategory).toBeUndefined()
    expect(reportLessons[0]?.criterionFailures).toHaveLength(2)

    const native = executionFailureFixture("child_turn_missing", "failed", true)
    expect(native.graph.nodes[0]?.native).toBeDefined()
    expect(deriveRootTaskHistoryLessonFacts(native.loaded, native.graph)[0]?.executionFailureCategory).toBeUndefined()

    const forged = { ...ordinary.graph, nodes: [{ ...ordinary.graph.nodes[0]!, executionFailureCategory: "resume_state_unavailable" as const }] }
    const unknownTask = { ...ordinary.task, failureReason: "provider_error" }
    const unknownLoaded = { ...ordinary.loaded, tasks: new Map([[unknownTask.id, unknownTask]]) }
    expect(deriveRootTaskHistoryLessonFacts(unknownLoaded, forged)[0]?.executionFailureCategory).toBeUndefined()
    expect(deriveRootTaskHistoryLessonFacts(ordinary.loaded,
      { ...ordinary.graph, nodes: [{ ...ordinary.graph.nodes[0]!, status: "running" }] })).toEqual([])

    let getterReads = 0
    const accessorTask = { ...ordinary.task }
    Object.defineProperty(accessorTask, "failureReason", { enumerable: true, get() { getterReads++; return "child_turn_missing" } })
    const accessorLoaded = { ...ordinary.loaded, tasks: new Map([[accessorTask.id, accessorTask]]) }
    expect(deriveRootTaskHistoryLessonFacts(accessorLoaded, ordinary.graph)[0]?.executionFailureCategory).toBeUndefined()
    expect(getterReads).toBe(0)
  })

  it("derives separate same-reason failures and a receipt-backed one-to-one repair link", () => {
    const { loaded, graph } = fixture(), lessons = deriveRootTaskHistoryLessonFacts(loaded, graph)
    expect(lessons).toHaveLength(2)
    expect(lessons[0]).toEqual({ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [
        { criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met", check: { role: "scout", kind: "candidate_count_gte", minimum: 2 } },
        { criterionOrdinal: 2, status: "failed", reasonCode: "criterion_not_met", check: { role: "scout", kind: "candidate_count_gte", minimum: 3 } },
      ] })
    expect(lessons[1]).toEqual({ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [], successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1, 2], status: "passed" }] })
    const serialized = JSON.stringify(lessons)
    for (const privateValue of [ROOT, "source-node-private", "source-task-private", "first-count", "private goal", DIGEST]) expect(serialized).not.toContain(privateValue)
  })

  it("adapts one loaded graph once and aligns safe facts with its original source ordinals", () => {
    const { loaded, graph } = fixture(), projection = projectLoadedRootTaskHistoryGraph(loaded)
    expect(projection?.taskGraph).toEqual(graph)
    expect(projection?.sourceNodeOrdinals).toEqual([1, 2])
    expect(projection?.nodeLessons).toEqual(deriveRootTaskHistoryLessonFacts(loaded, graph))
    expect(projection?.nodeLessons?.[0]?.criterionFailures[0]?.check).toEqual({ role: "scout", kind: "candidate_count_gte", minimum: 2 })
    expect(projection?.nodeLessons?.[1]?.successfulRepairs).toEqual([{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1, 2], status: "passed" }])
    expect(projection?.reportedOutputs).toBeUndefined()
    expect(projectLoadedRootTaskHistoryGraph({ ...loaded, item: null })).toBeUndefined()
  })

  it("keeps same-session details by default and limits historical-only projections to failures and repairs", () => {
    const { loaded } = fixture(), standard = projectLoadedRootTaskHistoryGraph(loaded)
    const historical = projectLoadedRootTaskHistoryGraph(loaded, true)
    expect(standard?.nodeLessons?.[0]?.criterionFailures[0]?.check).toEqual({ role: "scout", kind: "candidate_count_gte", minimum: 2 })
    expect(historical?.nodeLessons).toEqual([
      { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
        criterionFailures: [
          { criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" },
          { criterionOrdinal: 2, status: "failed", reasonCode: "criterion_not_met" },
        ] },
      { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
        criterionFailures: [], successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1, 2], status: "passed" }] },
    ])
    expect(JSON.stringify(historical?.nodeLessons)).not.toMatch(/check|minimum|executionFailureCategory|Count|count/)

    const reported = reportedOutputFixture()
    expect(projectLoadedRootTaskHistoryGraph(reported)?.reportedOutputs).toEqual([{ role: "scout", candidateCount: 5, resultStatus: "partial" }])
    expect(projectLoadedRootTaskHistoryGraph(reported, true)?.reportedOutputs).toBeUndefined()

    const categorized = executionFailureFixture("child_turn_missing")
    expect(projectLoadedRootTaskHistoryGraph(categorized.loaded, true)?.nodeLessons).toBeUndefined()
  })

  it("derives reported counts from the already-built projection without exposing its samples", () => {
    const loaded = reportedOutputFixture(), projection = projectLoadedRootTaskHistoryGraph(loaded)
    expect(projection?.sourceNodeOrdinals).toEqual([1])
    expect(projection?.reportedOutputs).toEqual([{ role: "scout", candidateCount: 5, resultStatus: "partial" }])
    expect(projection?.nodeLessons).toBeUndefined()
    expect(JSON.stringify(projection?.reportedOutputs)).not.toContain("job-")
    expect(JSON.stringify(projection?.reportedOutputs)).not.toContain("private text")
  })

  it("strictly reconstructs the allowlist and rejects guessed, augmented or unsafe lesson input", () => {
    const valid = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [{ criterionOrdinal: 1, status: "unverified", reasonCode: "canonical_evidence_missing" }],
      successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" }] }
    expect(parseRootTaskHistoryNodeLesson(valid)).toEqual(valid)
    expect(parseRootTaskHistoryNodeLesson({ ...valid, criterionId: "criterion-private" })).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...valid, nodeOrdinal: 1 })).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...valid, successfulRepairs: [{ ...valid.successfulRepairs[0]!, targetCriterionOrdinals: [2, 1] }] })).toBeUndefined()
    const getter = { ...valid }
    Object.defineProperty(getter, "criterionFailures", { enumerable: true, get() { throw new Error("must not read accessors") } })
    expect(parseRootTaskHistoryNodeLesson(getter)).toBeUndefined()
  })

  it("validates before reconstructing the cross-session failure and repair allowlist", () => {
    const lesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [{ criterionOrdinal: 1, status: "unverified", reasonCode: "canonical_evidence_missing",
        check: { role: "analyst", kind: "findings_cover_scout_candidates_gte", dependencyNodeOrdinal: 1, minimumPercent: 75 } }],
      successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" }] }
    expect(sanitizeRootTaskHistoryNodeLessonForCrossSession(lesson)).toEqual({
      ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [{ criterionOrdinal: 1, status: "unverified", reasonCode: "canonical_evidence_missing" }],
      successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" }],
    })
    expect(sanitizeRootTaskHistoryNodeLessonForCrossSession({ ...lesson, criterionFailures: [
      { ...lesson.criterionFailures[0]!, untrusted: "forged" },
    ] })).toBeUndefined()
    expect(sanitizeRootTaskHistoryNodeLessonForCrossSession({ ordinalScope: "source_graph_local", advisoryOnly: true,
      notCurrentEvidence: true, nodeOrdinal: 1, criterionFailures: [], executionFailureCategory: "execution_setup_unavailable" })).toBeUndefined()
  })

  it("retains source ordinals through selection and drops links when target evidence is absent", () => {
    const { loaded, graph } = fixture(), facts = deriveRootTaskHistoryLessonFacts(loaded, graph)
    expect(filterRootTaskHistoryLessonsForEmittedNodes(facts, [1, 2])).toEqual(facts)
    expect(filterRootTaskHistoryLessonsForEmittedNodes(facts, [2])).toEqual([undefined, undefined])
    const targetWithoutCriterion = [{ ...facts[0]!, criterionFailures: facts[0]!.criterionFailures.filter(item => item.criterionOrdinal === 1) }, facts[1]]
    const pruned = filterRootTaskHistoryLessonsForEmittedNodes(targetWithoutCriterion, [1, 2])
    expect(pruned[1]?.successfulRepairs).toBeUndefined()
    expect(filterRootTaskHistoryLessonsForEmittedNodes(facts, [1, 1])).toEqual([undefined, undefined])
  })

  it("omits success when coverage is incomplete, duplicated, or the receipt is stale", () => {
    const incomplete = fixture({ targetStatuses: ["failed", "passed"] })
    expect(deriveRootTaskHistoryLessonFacts(incomplete.loaded, incomplete.graph)[1]?.successfulRepairs).toBeUndefined()
    const duplicate = fixture({ repairCount: 2 })
    expect(deriveRootTaskHistoryLessonFacts(duplicate.loaded, duplicate.graph).slice(1).every(item => !item?.successfulRepairs)).toBe(true)
    const { loaded, graph } = fixture(), repair = loaded.snapshot!.nodes[1]!, oldTask = loaded.tasks.get(repair.taskId)!
    const badResult = oldTask.result as Record<string, unknown>, badReceipt = { ...(badResult.taskGraphRepairReceipt as Record<string, unknown>), evidenceDigest: "b".repeat(64) }
    const tasks = new Map(loaded.tasks).set(repair.taskId, { ...oldTask, result: { ...badResult, taskGraphRepairReceipt: badReceipt } })
    expect(deriveRootTaskHistoryLessonFacts({ ...loaded, tasks }, graph)[1]?.successfulRepairs).toBeUndefined()
    expect(deriveRootTaskHistoryLessonFacts({ ...loaded, state: { ...loaded.state!, repairSatisfiedNodeKeys: [] } }, graph)[1]?.successfulRepairs).toBeUndefined()
    const missing = new Map(loaded.tasks).set(repair.taskId, { ...oldTask, result: { taskGraphVerificationReport: badResult.taskGraphVerificationReport } })
    expect(deriveRootTaskHistoryLessonFacts({ ...loaded, tasks: missing }, graph)[1]?.successfulRepairs).toBeUndefined()

    const malformedReceipt = { ...badReceipt, extraPrivateField: "forged" }
    const malformed = new Map(loaded.tasks).set(repair.taskId, { ...oldTask,
      result: { ...badResult, taskGraphRepairReceipt: malformedReceipt } })
    expect(deriveRootTaskHistoryLessonFacts({ ...loaded, tasks: malformed }, graph)[1]?.successfulRepairs).toBeUndefined()
  })

  it("rejects a receipt repointed to a different existing failed target", () => {
    const original = fixture(), originalSnapshot = original.loaded.snapshot!, originalRepair = originalSnapshot.nodes[1]!
    const otherTarget = { ...originalSnapshot.nodes[0]!, key: "other-target-private", taskId: "other-target-task-private" }
    const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: [originalSnapshot.nodes[0]!, otherTarget, originalRepair] })
    const tasks = new Map(original.loaded.tasks)
    tasks.set(otherTarget.taskId, { id: otherTarget.taskId, status: "failed", role: "scout", failureReason: "task_graph_verification_failed",
      result: { taskGraphVerificationReport: report("failed") } })
    const statuses = new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }] as const))
    const base = taskGraphState(snapshot, 7, statuses, []), coverage = resolveTaskGraphRepairDependencies(snapshot, tasks, ROOT)
    const state = { ...base, repairSatisfiedNodeKeys: coverage.satisfied, repairPendingNodeKeys: coverage.pending }
    const loaded: LoadedGraph = { ...original.loaded, snapshot, tasks, state }
    const graph = currentTaskGraph(loaded), repairTask = tasks.get(originalRepair.taskId)!, result = repairTask.result as Record<string, unknown>
    const receipt = result.taskGraphRepairReceipt as Record<string, unknown>
    const repointedReceipt = { ...receipt, targetNodeKey: otherTarget.key, targetTaskId: otherTarget.taskId }
    const repointedTasks = new Map(tasks).set(repairTask.id, { ...repairTask,
      result: { ...result, taskGraphRepairReceipt: repointedReceipt } })
    const repairIndex = graph.nodes.findIndex(node => node.key === originalRepair.key)
    const repointedGraph = { ...graph, nodes: graph.nodes.map((node, index) => index === repairIndex
      ? { ...node, repairReceipt: repointedReceipt as typeof node.repairReceipt } : node) }

    expect(snapshot.nodes.some(node => node.key === otherTarget.key)).toBe(true)
    expect(deriveRootTaskHistoryLessonFacts({ ...loaded, tasks: repointedTasks }, repointedGraph)[repairIndex]?.successfulRepairs).toBeUndefined()
  })

  it("omits an exact-repair relationship when successful receipt coverage partially overlaps", () => {
    const { loaded, graph, targetKey } = overlappingCoverageFixture()
    const lessons = deriveRootTaskHistoryLessonFacts(loaded, graph)
    expect(loaded.state?.repairSatisfiedNodeKeys).not.toContain(targetKey)
    expect(lessons.slice(1).every(lesson => !lesson?.successfulRepairs)).toBe(true)
  })

  it("records failed repair criteria without a success link and resets ordinals for each source graph", () => {
    const failedRepair = fixture({ repairStatus: "failed" })
    const failedFacts = deriveRootTaskHistoryLessonFacts(failedRepair.loaded, failedRepair.graph)
    expect(failedFacts[1]).toMatchObject({ nodeOrdinal: 2,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed" }, { criterionOrdinal: 2, status: "failed" }] })
    expect(failedFacts[1]?.successfulRepairs).toBeUndefined()
    const otherSource = fixture()
    expect(deriveRootTaskHistoryLessonFacts(otherSource.loaded, otherSource.graph).map(item => item?.nodeOrdinal)).toEqual([1, 2])
  })

  it("keeps an unverified repair report from becoming a success link", () => {
    const unverified = fixture({ repairStatus: "failed", repairReportStatus: "unverified" })
    const lesson = deriveRootTaskHistoryLessonFacts(unverified.loaded, unverified.graph)[1]
    expect(lesson?.criterionFailures).toMatchObject([
      { criterionOrdinal: 1, status: "unverified", reasonCode: "canonical_evidence_missing" },
      { criterionOrdinal: 2, status: "unverified", reasonCode: "canonical_evidence_missing" },
    ])
    expect(lesson?.successfulRepairs).toBeUndefined()
  })

  it("rejects mismatched graph/report identity and changed same-ID repair checks", () => {
    const { loaded, graph } = fixture()
    expect(deriveRootTaskHistoryLessonFacts(loaded, { ...graph, revision: graph.revision + 1 })).toEqual([])
    expect(deriveRootTaskHistoryLessonFacts(loaded, { ...graph, nodes: [...graph.nodes].reverse() })).toEqual([])
    const unknownReport = { ...graph.nodes[0]!.verificationReport!, criteria: [{ ...graph.nodes[0]!.verificationReport!.criteria[0]!, criterionId: "unknown" }, graph.nodes[0]!.verificationReport!.criteria[1]!] }
    expect(deriveRootTaskHistoryLessonFacts(loaded, { ...graph, nodes: [{ ...graph.nodes[0]!, verificationReport: unknownReport }, graph.nodes[1]!] })).toEqual([])
    const reversedReport = { ...graph.nodes[0]!.verificationReport!, criteria: [...graph.nodes[0]!.verificationReport!.criteria].reverse() }
    expect(deriveRootTaskHistoryLessonFacts(loaded, { ...graph, nodes: [{ ...graph.nodes[0]!, verificationReport: reversedReport }, graph.nodes[1]!] })).toEqual([])

    const repair = loaded.snapshot!.nodes[1]!, oldRelation = repair.repairOf!, changedRelation = { ...oldRelation, taskId: "replacement-task-private" }
    const changedSnapshot: TaskGraphSnapshot = { ...loaded.snapshot!, nodes: [loaded.snapshot!.nodes[0]!, { ...repair, repairOf: changedRelation }] }
    const changedState = { ...loaded.state!, nodes: [loaded.state!.nodes[0]!, { ...loaded.state!.nodes[1]!, repairOf: changedRelation }] }
    const changedGraph = { ...graph, nodes: [graph.nodes[0]!, { ...graph.nodes[1]!, repairOf: changedRelation }] }
    expect(deriveRootTaskHistoryLessonFacts({ ...loaded, snapshot: changedSnapshot, state: changedState }, changedGraph)[1]?.successfulRepairs).toBeUndefined()
    const missingTarget = { ...oldRelation, nodeKey: "replacement-node-private" }
    const missingTargetSnapshot: TaskGraphSnapshot = { ...loaded.snapshot!, nodes: [loaded.snapshot!.nodes[0]!, { ...repair, repairOf: missingTarget }] }
    const missingTargetState = { ...loaded.state!, nodes: [loaded.state!.nodes[0]!, { ...loaded.state!.nodes[1]!, repairOf: missingTarget }] }
    const missingTargetGraph = { ...graph, nodes: [graph.nodes[0]!, { ...graph.nodes[1]!, repairOf: missingTarget }] }
    expect(deriveRootTaskHistoryLessonFacts({ ...loaded, snapshot: missingTargetSnapshot, state: missingTargetState }, missingTargetGraph)[1]?.successfulRepairs).toBeUndefined()

    const sourceRepair = loaded.snapshot!.nodes[1]!, changedContract = { ...sourceRepair.verification!, criteria: sourceRepair.verification!.criteria.map(item => ({
      ...item, check: { kind: "candidate_count_gte" as const, minimum: 99 },
    })) }
    const changedRepair: StoredTaskGraphNode = { ...sourceRepair, verification: changedContract }
    const snapshot: TaskGraphSnapshot = { ...loaded.snapshot!, nodes: [loaded.snapshot!.nodes[0]!, changedRepair] }
    const state = { ...loaded.state!, nodes: [loaded.state!.nodes[0]!, { ...loaded.state!.nodes[1]!, verification: changedContract }] }
    const facts = deriveRootTaskHistoryLessonFacts({ ...loaded, snapshot, state }, graph)
    expect(facts[1]?.successfulRepairs).toBeUndefined()

    const analystContract = { ...sourceRepair.verification!, role: "analyst" as const, criteria: sourceRepair.verification!.criteria.map(item => ({
      ...item, check: { kind: "finding_count_gte" as const, minimum: 1 },
    })) }
    const analystRepair = { ...sourceRepair, templateId: "analyst", verification: analystContract }
    const analystSnapshot: TaskGraphSnapshot = { ...loaded.snapshot!, nodes: [loaded.snapshot!.nodes[0]!, analystRepair] }
    const analystState = { ...loaded.state!, nodes: [loaded.state!.nodes[0]!, { ...loaded.state!.nodes[1]!, templateId: "analyst", verification: analystContract }] }
    const analystTasks = new Map(loaded.tasks).set(sourceRepair.taskId, { ...loaded.tasks.get(sourceRepair.taskId)!, role: "analyst" })
    const analystGraph = { ...graph, nodes: [graph.nodes[0]!, { ...graph.nodes[1]!, templateId: "analyst" }] }
    expect(deriveRootTaskHistoryLessonFacts({ ...loaded, snapshot: analystSnapshot, state: analystState, tasks: analystTasks }, analystGraph)[1]?.successfulRepairs).toBeUndefined()
  })
})
