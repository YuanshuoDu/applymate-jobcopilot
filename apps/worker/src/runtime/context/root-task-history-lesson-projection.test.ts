import { describe, expect, it } from "vitest"
import { deriveRootTaskHistoryLessonFacts, filterRootTaskHistoryLessonsForEmittedNodes, parseRootTaskHistoryNodeLesson } from "./root-task-history-lesson-projection.js"
import { currentTaskGraph, type GraphTaskRow, type LoadedGraph } from "../subagents/task-graph-pg-state.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphState, type StoredTaskGraphNode, type TaskGraphSnapshot } from "../subagents/task-graph-snapshot.js"
import { TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION } from "../subagents/task-graph-command-port.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-pg-verification.js"
import { resolveTaskGraphRepairDependencies } from "../subagents/task-graph-dependency-context.js"

const ROOT = "private-root-id"
const CRITERIA = [
  { id: "first-count", check: { kind: "candidate_count_gte", minimum: 2 } },
  { id: "second-count", check: { kind: "candidate_count_gte", minimum: 3 } },
] as const
const CONTRACT = { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "scout", criteria: CRITERIA } as const
const DIGEST = "a".repeat(64)

function report(status: "failed" | "passed", ids: readonly string[] = CRITERIA.map(item => item.id), statuses?: readonly ("failed" | "passed")[]) {
  const criteria = ids.map((criterionId, index) => {
    const criterionStatus = statuses?.[index] ?? status
    return { criterionId, status: criterionStatus, reasonCode: criterionStatus === "passed" ? "criteria_met" : "criterion_not_met" }
  })
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status, reasonCode: status === "passed" ? "criteria_met" : "criterion_not_met",
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
function fixture(options: { repairCount?: number; targetStatuses?: readonly ("failed" | "passed")[]; repairStatus?: "failed" | "completed" } = {}) {
  const repairCount = options.repairCount ?? 1, snapshot = snapshotWith(repairCount, options.targetStatuses)
  const tasks = new Map<string, GraphTaskRow>()
  tasks.set("source-task-private", { id: "source-task-private", status: "failed", role: "scout", failureReason: "task_graph_verification_failed",
    result: { taskGraphVerificationReport: report("failed", undefined, options.targetStatuses) } })
  for (let index = 0; index < repairCount; index++) {
    const node = snapshot.nodes[index + 1]!, repairStatus = options.repairStatus ?? "completed"
    const taskReport = report(repairStatus === "completed" ? "passed" : "failed")
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

describe("root history ordinal lessons", () => {
  it("derives separate same-reason failures and a receipt-backed one-to-one repair link", () => {
    const { loaded, graph } = fixture(), lessons = deriveRootTaskHistoryLessonFacts(loaded, graph)
    expect(lessons).toHaveLength(2)
    expect(lessons[0]).toEqual({ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }, { criterionOrdinal: 2, status: "failed", reasonCode: "criterion_not_met" }] })
    expect(lessons[1]).toEqual({ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [], successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1, 2], status: "passed" }] })
    const serialized = JSON.stringify(lessons)
    for (const privateValue of [ROOT, "source-node-private", "source-task-private", "first-count", "private goal", DIGEST]) expect(serialized).not.toContain(privateValue)
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
