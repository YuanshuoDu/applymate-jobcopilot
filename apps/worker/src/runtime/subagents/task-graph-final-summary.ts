import { validateRoleResult, type ArtifactVersionReference, type StructuredRole, type StructuredRoleResult } from "./role-results.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { isTerminalSubagentStatus, type SubagentTaskStatus } from "./types.js"

export type TaskGraphFinalSummaryNode = Readonly<{
  /** Assigned by the future server-side graph reader, never inferred from model output. */
  kind: "business" | "internal_control"
  taskId: string
  role: string
  taskStatus: SubagentTaskStatus
  /** Full role result extracted from the persisted task result, not the bounded context projection. */
  structuredResult?: unknown
}>

export type TaskGraphFinalSummaryInput = Readonly<{
  graphRevision: number
  nodes: readonly TaskGraphFinalSummaryNode[]
}>

export type TaskGraphSummaryCoverage = "complete" | "partial" | "unavailable" | "not_requested"
export type TaskGraphSummaryCount = Readonly<{ knownCount: number | null; coverage: TaskGraphSummaryCoverage }>
export type TaskGraphFinalSummary = Readonly<{
  graphRevision: number
  counts: Readonly<{
    discoveredJobs: TaskGraphSummaryCount
    analyzedJobs: TaskGraphSummaryCount
    artifactReferences: TaskGraphSummaryCount
    reviewOutcomes: TaskGraphSummaryCount
  }>
  discoveredJobs: readonly Readonly<{ jobId: string; taskIds: readonly string[] }>[]
  analyzedJobs: readonly Readonly<{ jobId: string; findings: readonly Readonly<{ taskId: string; score: number }>[] }>[]
  artifactReferences: readonly Readonly<{ artifactRef: ArtifactVersionReference; taskIds: readonly string[] }>[]
  reviewOutcomes: readonly Readonly<{ artifactRef: ArtifactVersionReference; reviewStatus: "passed" | "needs_revision" | "rejected" | "stale"; taskIds: readonly string[] }>[]
  taskOutcomes: readonly Readonly<{
    taskId: string
    role: StructuredRole | "unsupported"
    taskStatus: SubagentTaskStatus
    resultState: "valid" | "missing" | "invalid" | "unsupported_role" | "not_terminal"
    roleResultStatus?: "completed" | "partial"
  }>[]
}>

type SummaryNode = TaskGraphFinalSummaryNode
type SummaryTask = Readonly<{ node: SummaryNode; result?: StructuredRoleResult; resultState: TaskGraphFinalSummary["taskOutcomes"][number]["resultState"] }>
type ProvenanceSet = Map<string, Set<string>>
const STATUSES = new Set<SubagentTaskStatus>(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

/** Pure advisory reduction over one caller-selected current graph revision. */
export function reduceTaskGraphFinalSummary(input: TaskGraphFinalSummaryInput): TaskGraphFinalSummary {
  const { graphRevision, nodes } = validateEnvelope(input)
  const seenTaskIds = new Set<string>()
  for (const node of nodes) {
    if (seenTaskIds.has(node.taskId)) throw new Error("task_graph_final_summary_task_identity_conflict")
    seenTaskIds.add(node.taskId)
  }
  const tasks: SummaryTask[] = nodes.filter(node => node.kind === "business").map(summarizeTask)
  const discovered = new Map<string, Set<string>>()
  const analyzed = new Map<string, Map<string, Set<number>>>()
  const artifacts = new Map<string, { artifactRef: ArtifactVersionReference; taskIds: Set<string> }>()
  const reviews = new Map<string, { artifactRef: ArtifactVersionReference; reviewStatus: "passed" | "needs_revision" | "rejected" | "stale"; taskIds: Set<string> }>()
  for (const task of tasks) {
    const { node, result } = task
    if (!result) continue
    if (result.role === "scout") for (const candidate of result.candidates) addTask(discovered, candidate.jobId, node.taskId)
    if (result.role === "analyst") for (const finding of result.findings) {
      let findings = analyzed.get(finding.jobId)
      if (!findings) analyzed.set(finding.jobId, findings = new Map())
      let scores = findings.get(node.taskId)
      if (!scores) findings.set(node.taskId, scores = new Set())
      scores.add(finding.score)
    }
    if (result.role === "writer" || result.role === "reviewer") addArtifact(artifacts, result.artifactRef, node.taskId)
    if (result.role === "reviewer") addReview(reviews, result.artifactRef, result.reviewStatus, node.taskId)
  }
  const scouts = tasks.filter(task => task.node.role === "scout")
  const analysts = tasks.filter(task => task.node.role === "analyst")
  const artifactTasks = tasks.filter(task => task.node.role === "writer" || task.node.role === "reviewer")
  const reviewerTasks = tasks.filter(task => task.node.role === "reviewer")
  return {
    graphRevision,
    counts: {
      discoveredJobs: count(scouts, discovered.size), analyzedJobs: count(analysts, analyzed.size),
      artifactReferences: count(artifactTasks, artifacts.size), reviewOutcomes: count(reviewerTasks, reviews.size),
    },
    discoveredJobs: [...discovered].sort(([left], [right]) => compareText(left, right))
      .map(([jobId, taskIds]) => ({ jobId, taskIds: sorted(taskIds) })),
    analyzedJobs: [...analyzed].sort(([left], [right]) => compareText(left, right)).map(([jobId, findings]) => ({
      jobId, findings: [...findings].flatMap(([taskId, scores]) => [...scores].map(score => ({ taskId, score })))
        .sort((left, right) => compareText(left.taskId, right.taskId) || left.score - right.score),
    })),
    artifactReferences: [...artifacts.values()].sort((left, right) => compareArtifact(left.artifactRef, right.artifactRef))
      .map(item => ({ artifactRef: item.artifactRef, taskIds: sorted(item.taskIds) })),
    reviewOutcomes: [...reviews.values()].sort((left, right) => compareArtifact(left.artifactRef, right.artifactRef) || compareText(left.reviewStatus, right.reviewStatus))
      .map(item => ({ artifactRef: item.artifactRef, reviewStatus: item.reviewStatus, taskIds: sorted(item.taskIds) })),
    taskOutcomes: tasks.map(task => {
      const role: StructuredRole | "unsupported" = isRole(task.node.role) ? task.node.role : "unsupported"
      return { taskId: task.node.taskId, role, taskStatus: task.node.taskStatus, resultState: task.resultState,
        ...(task.result ? { roleResultStatus: task.result.status } : {}) }
    })
      .sort((left, right) => compareText(left.taskId, right.taskId)),
  }
}

function summarizeTask(node: SummaryNode): SummaryTask {
  if (!isRole(node.role)) return { node, resultState: "unsupported_role" }
  if (!isTerminalSubagentStatus(node.taskStatus)) return { node, resultState: "not_terminal" }
  if (node.structuredResult === undefined || node.structuredResult === null) return { node, resultState: "missing" }
  try {
    const result = validateRoleResult(node.structuredResult, node.role)
    return safeResultIdentifiers(result) ? { node, result, resultState: "valid" } : { node, resultState: "invalid" }
  }
  catch { return { node, resultState: "invalid" } }
}

function safeResultIdentifiers(result: StructuredRoleResult): boolean {
  if (result.role === "scout") return result.candidates.every(candidate => SAFE_IDENTIFIER.test(candidate.jobId))
  if (result.role === "analyst") return result.findings.every(finding => SAFE_IDENTIFIER.test(finding.jobId))
  return SAFE_IDENTIFIER.test(result.artifactRef.artifactId)
}

function count(tasks: readonly SummaryTask[], knownCount: number): TaskGraphSummaryCount {
  if (tasks.length === 0) return { knownCount: null, coverage: "not_requested" }
  const complete = tasks.every(task => task.node.taskStatus === "completed" && task.result?.status === "completed")
  if (complete) return { knownCount, coverage: "complete" }
  return { knownCount: tasks.some(task => task.result) ? knownCount : null, coverage: tasks.some(task => task.result) ? "partial" : "unavailable" }
}

function validateEnvelope(input: unknown): { graphRevision: number; nodes: SummaryNode[] } {
  const row = record(input)
  if (!row || !exactKeys(row, "graphRevision,nodes") || !Number.isSafeInteger(row.graphRevision) || Number(row.graphRevision) < 0
    || !denseArray(row.nodes) || row.nodes.length > TASK_GRAPH_LIMITS.maxNodes
    || row.graphRevision === 0 && row.nodes.length > 0) throw new Error("task_graph_final_summary_envelope_invalid")
  const nodes = row.nodes.map(value => {
    const node = record(value), hasResult = !!node && Object.hasOwn(node, "structuredResult")
    const keys = hasResult ? "kind,role,structuredResult,taskId,taskStatus" : "kind,role,taskId,taskStatus"
    if (!node || !exactKeys(node, keys) || (node.kind !== "business" && node.kind !== "internal_control")
      || typeof node.taskId !== "string" || !node.taskId.trim() || node.taskId.length > TASK_GRAPH_LIMITS.maxKeyLength
      || !SAFE_IDENTIFIER.test(node.taskId)
      || typeof node.role !== "string" || !node.role.trim() || node.role.length > 64 || !STATUSES.has(node.taskStatus as SubagentTaskStatus)) {
      throw new Error("task_graph_final_summary_node_invalid")
    }
    return node as unknown as SummaryNode
  })
  return { graphRevision: Number(row.graphRevision), nodes }
}

function addTask(index: ProvenanceSet, id: string, taskId: string): void {
  let tasks = index.get(id)
  if (!tasks) index.set(id, tasks = new Set())
  tasks.add(taskId)
}
function addArtifact(index: Map<string, { artifactRef: ArtifactVersionReference; taskIds: Set<string> }>, artifactRef: ArtifactVersionReference, taskId: string): void {
  const key = artifactKey(artifactRef), item = index.get(key) ?? { artifactRef, taskIds: new Set<string>() }
  item.taskIds.add(taskId); index.set(key, item)
}
function addReview(index: Map<string, { artifactRef: ArtifactVersionReference; reviewStatus: "passed" | "needs_revision" | "rejected" | "stale"; taskIds: Set<string> }>, artifactRef: ArtifactVersionReference, reviewStatus: "passed" | "needs_revision" | "rejected" | "stale", taskId: string): void {
  const key = JSON.stringify([artifactKey(artifactRef), reviewStatus]), item = index.get(key) ?? { artifactRef, reviewStatus, taskIds: new Set<string>() }
  item.taskIds.add(taskId); index.set(key, item)
}
function artifactKey(value: ArtifactVersionReference): string { return JSON.stringify([value.artifactId, value.version, value.contentHash, value.sourceDigest]) }
function compareArtifact(left: ArtifactVersionReference, right: ArtifactVersionReference): number {
  return compareText(left.artifactId, right.artifactId) || left.version - right.version || compareText(left.contentHash, right.contentHash) || compareText(left.sourceDigest, right.sourceDigest)
}
function sorted(values: ReadonlySet<string>): string[] { return [...values].sort(compareText) }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function isRole(value: string): value is StructuredRole { return value === "scout" || value === "analyst" || value === "writer" || value === "reviewer" }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.getOwnPropertySymbols(value).length === 0 ? value as Record<string, unknown> : null }
  catch { return null }
}
function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}
function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return false
  return Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
}
