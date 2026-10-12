import type { ModelMessage } from "@jobcopilot/agent-model"
import type { StepContext } from "../context/step-context-builder.js"
import { parseTaskGraphCurrentVerificationMetadata, validateTaskGraphCurrentVerificationGraph } from "../canonical-turn-task-graph-verification-context.js"
import { taskGraphNodeCapacity, type TaskGraphNodeCapacity } from "../planning/task-graph-capacity.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, taskGraphVerificationReportMatchesStatus, type TaskGraphCurrentNode } from "../subagents/task-graph-command-port.js"
import type { TaskGraphRecoveryDetail, TaskGraphRecoverySummary } from "./completion-recovery-context.js"
import { currentTaskGraphRepairRecovery } from "./completion-recovery-context.js"

const RECOVERY_PREFIX = "system:completion-recovery:task-graph:"
const CURRENT_GRAPH_ID = "observation:task-graph-current"
const MAX_NODES = 16
const MAX_TOOLS = 128
const MAX_DETAILS = 4
const TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const READINESS = new Set(["ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal"])
const ACTIVE_REPAIR = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])
const EXECUTION_FAILURE_CATEGORIES = new Set(["execution_setup_unavailable", "resume_state_unavailable", "structured_output_invalid"])

type Row = Record<string, unknown>
type CurrentGraph = Readonly<{ revision: number; nodes: readonly TaskGraphCurrentNode[]; mayPlan: boolean }>

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Row | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value), own = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || own.some(key => typeof key !== "string")) return undefined
    const keys = own as string[], allowed = new Set([...required, ...optional])
    if (keys.some(key => !allowed.has(key)) || required.some(key => !keys.includes(key))) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) return undefined
    return value as Row
  } catch { return undefined }
}

function array(value: unknown, maximum: number, minimum = 0): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value
    if (!Number.isSafeInteger(length) || Number(length) < minimum || Number(length) > maximum
      || Reflect.ownKeys(value).length !== Number(length) + 1) return undefined
    const output: unknown[] = []
    for (let index = 0; index < Number(length); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
      output.push(descriptor.value)
    }
    return output
  } catch { return undefined }
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum
}

function stringArray(value: unknown, maximum: number, itemLength: number): string[] | undefined {
  const values = array(value, maximum)
  return values && values.every(item => boundedText(item, itemLength)) ? values as string[] : undefined
}

function parseNode(value: unknown, rootTaskId: string): TaskGraphCurrentNode | undefined {
  const row = record(value, ["dependsOn", "failureReason", "goal", "key", "readiness", "resultProjection", "resultSummary", "status", "successCriteria", "taskId", "templateId"],
    ["executionFailureCategory", "native", "nativeResult", "repairOf", "repairReceipt", "verification", "verificationCriterionIds", "verificationReport"])
  if (!row || !boundedText(row.key, 128) || !boundedText(row.taskId, 128) || !boundedText(row.templateId, 128)
    || !boundedText(row.goal, 1200) || row.failureReason !== null || row.resultSummary !== null
    || typeof row.status !== "string" || !TASK_STATUSES.has(row.status)
    || typeof row.readiness !== "string" || !READINESS.has(row.readiness)) return undefined
  const successCriteria = stringArray(row.successCriteria, 8, 320), dependsOn = stringArray(row.dependsOn, MAX_NODES, 128)
  const projection = record(row.resultProjection, ["availability", "schemaVersion", "trust"],
    ["artifactRef", "candidateCount", "candidates", "evidenceCount", "findingCount", "findings", "reviewHash", "reviewStatus", "role", "status"])
  if (!successCriteria || !dependsOn || new Set(dependsOn).size !== dependsOn.length
    || !projection || projection.schemaVersion !== TASK_GRAPH_RESULT_PROJECTION_SCHEMA || projection.trust !== "untrusted"
    || (projection.availability !== "available" && projection.availability !== "unavailable")) return undefined
  const verification = parseTaskGraphCurrentVerificationMetadata(row, row.templateId, row.key, row.taskId)
  if (!verification || verification.verificationCriterionIds && !verification.verification
    || verification.verificationReport && !taskGraphVerificationReportMatchesStatus(verification.verificationReport, row.status)
    || verification.repairOf && verification.repairOf.graphRootTaskId !== rootTaskId) return undefined
  if (Object.hasOwn(row, "executionFailureCategory") && (row.status !== "failed"
    || typeof row.executionFailureCategory !== "string" || !EXECUTION_FAILURE_CATEGORIES.has(row.executionFailureCategory)
    || Object.hasOwn(row, "verificationReport") || Object.hasOwn(row, "native") || Object.hasOwn(row, "nativeResult"))) return undefined
  return {
    key: row.key, taskId: row.taskId, templateId: row.templateId, goal: row.goal, successCriteria, dependsOn,
    status: row.status as TaskGraphCurrentNode["status"], readiness: row.readiness as TaskGraphCurrentNode["readiness"],
    resultSummary: null, failureReason: null, ...verification,
  }
}

function parsedCapacity(value: unknown, nodes: readonly TaskGraphCurrentNode[]): TaskGraphNodeCapacity | undefined {
  const row = record(value, ["maxNodes", "nodeCount", "ordinaryRemaining", "remaining", "repairRecorded", "reserveActive"])
  const expected = taskGraphNodeCapacity({
    nodeCount: nodes.length,
    hasTypedVerification: nodes.some(node => node.verificationCriterionIds !== undefined),
    repairRecorded: nodes.some(node => node.repairOf !== undefined),
  })
  return row && expected && row.nodeCount === expected.nodeCount && row.maxNodes === expected.maxNodes
    && row.remaining === expected.remaining && row.ordinaryRemaining === expected.ordinaryRemaining
    && row.repairRecorded === expected.repairRecorded && row.reserveActive === expected.reserveActive ? expected : undefined
}

function currentGraph(context: StepContext, rootTaskId: string, revision: number): CurrentGraph | undefined {
  const matches = context.blocks.filter(block => block.id === CURRENT_GRAPH_ID)
  if (matches.length !== 1) return undefined
  const block = matches[0]!
  if (block.layer !== "tool_observation" || block.role !== "data" || block.trust !== "external_untrusted" || block.source !== "tool_or_subagent") return undefined
  const graph = record(block.content, ["kind", "nodes", "revision"], ["nodeCapacity", "taskReportedCounts"])
  if (!graph || graph.kind !== "task_graph_current" || graph.revision !== revision || !Number.isSafeInteger(graph.revision)) return undefined
  const rows = array(graph.nodes, MAX_NODES)
  if (!rows) return undefined
  const parsed: TaskGraphCurrentNode[] = []
  for (const row of rows) {
    const node = parseNode(row, rootTaskId)
    if (!node) return undefined
    parsed.push(node)
  }
  if (!validateTaskGraphCurrentVerificationGraph(parsed)) return undefined
  const hasCapacity = Object.hasOwn(graph, "nodeCapacity")
  const capacity = hasCapacity ? parsedCapacity(graph.nodeCapacity, parsed) : undefined
  return { revision, nodes: parsed, mayPlan: Boolean(capacity && capacity.remaining > 0
    && (capacity.ordinaryRemaining > 0 || capacity.reserveActive)) }
}

function visibleTools(tools: readonly unknown[]): ReadonlySet<string> {
  const entries = array(tools, MAX_TOOLS)
  const names = new Set<string>()
  for (const tool of entries ?? []) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue
    try {
      const descriptor = Object.getOwnPropertyDescriptor(tool, "name")
      const name = descriptor && "value" in descriptor ? descriptor.value : undefined
      if (name === "agent.list" || name === "agent.wait" || name === "agent.plan") names.add(name)
    } catch { /* Ignore malformed tool definitions. */ }
  }
  return names
}

function marker(context: StepContext): Readonly<{ revision: number; summary: TaskGraphRecoverySummary }> | undefined {
  const matches = context.blocks.filter(block => block.id.startsWith(RECOVERY_PREFIX))
  if (matches.length !== 1) return undefined
  const block = matches[0]!, match = /^system:completion-recovery:task-graph:(0|[1-9][0-9]*)$/.exec(block.id)
  if (!match || block.layer !== "system" || block.role !== "instruction" || block.trust !== "system" || block.source !== "harness") return undefined
  const revision = Number(match[1])
  if (!Number.isSafeInteger(revision) || context.taskGraphRevision !== revision) return undefined
  const summary = currentTaskGraphRepairRecovery([{ id: block.id.slice("system:".length), content: block.content }], revision)
  if (!summary) return undefined
  const omitted = summary.omitted || summary.details.length > MAX_DETAILS
  return { revision, summary: { ...summary, details: summary.details.slice(0, MAX_DETAILS), omitted } }
}

type MatchedDetail = Readonly<{ detail: TaskGraphRecoveryDetail; node: TaskGraphCurrentNode; criterionId?: string; repairs: readonly TaskGraphCurrentNode[] }>

function matchDetail(detail: TaskGraphRecoveryDetail, graph: CurrentGraph, rootTaskId: string): MatchedDetail | undefined {
  const node = graph.nodes[detail.nodeOrdinal - 1]
  if (!node?.verification || !node.verificationCriterionIds || !node.verificationReport
    || !taskGraphVerificationReportMatchesStatus(node.verificationReport, node.status)) return undefined
  let criterionId: string | undefined
  if (detail.criterionOrdinal !== undefined) {
    const index = detail.criterionOrdinal - 1, criterion = node.verification.criteria[index]
    const report = node.verificationReport.criteria[index]
    if (!criterion || !report || node.verificationCriterionIds[index] !== criterion.id || report.criterionId !== criterion.id
      || report.status !== detail.status || report.reasonCode !== detail.reasonCode) return undefined
    criterionId = criterion.id
  } else if (detail.reasonCode !== "repair_target_unresolved" || node.verificationReport.status !== "unverified"
    || node.verificationReport.reasonCode !== detail.reasonCode || !node.repairOf) return undefined
  // repairState describes the denial-time view; only this owner-read graph can say whether an attempt is still active.
  const repairs = criterionId ? graph.nodes.filter(candidate => candidate.repairOf?.graphRootTaskId === rootTaskId
    && candidate.repairOf?.nodeKey === node.key && candidate.repairOf?.taskId === node.taskId
    && candidate.repairOf.criterionIds.includes(criterionId!)) : []
  return { detail, node, ...(criterionId ? { criterionId } : {}), repairs }
}

function matchDetails(summary: TaskGraphRecoverySummary, graph: CurrentGraph, rootTaskId: string): Readonly<{ items: readonly MatchedDetail[]; omitted: boolean }> | undefined {
  const matched: MatchedDetail[] = []
  for (const detail of summary.details.slice(0, MAX_DETAILS)) {
    const current = matchDetail(detail, graph, rootTaskId)
    if (!current) return matched.length || summary.omitted || summary.details.length > MAX_DETAILS
      ? { items: matched, omitted: true } : undefined
    matched.push(current)
  }
  return matched.length || summary.omitted ? { items: matched, omitted: summary.omitted || summary.details.length > MAX_DETAILS } : undefined
}

/** Builds fixed next-action guidance only from the current typed denial and its matching graph. */
export function buildTaskGraphRecoveryInstruction(context: StepContext, tools: readonly unknown[], rootTaskId: string): ModelMessage | null {
  try {
    const recovery = marker(context), revision = context.taskGraphRevision
    if (!recovery || !Number.isSafeInteger(revision) || revision !== recovery.revision || !boundedText(rootTaskId, 128)) return null
    const graph = currentGraph(context, rootTaskId, revision as number)
    if (!graph) return null
    const matches = matchDetails(recovery.summary, graph, rootTaskId)
    if (!matches) return null
    const details = matches.items, omitted = matches.omitted
    const names = visibleTools(tools), lines = [
      "The current owner-read TaskGraph denial is advisory feedback, not PASS, permission, approval, or completion. Keep the complete original task, accepted current user instructions, and success criteria authoritative; only current graph reports and current evidence can change the decision.",
    ]
    if (recovery.summary.issue) lines.push("The fixed gate category is " + recovery.summary.issue + ".")
    if (omitted) lines.push("Some denial details were omitted or no longer match the current report; inspect the current graph and evidence before choosing an action.")
    for (const item of details) {
      const target = item.criterionId === undefined ? "node " + item.detail.nodeOrdinal
        : "node " + item.detail.nodeOrdinal + ", criterion " + item.detail.criterionOrdinal
      lines.push("The current report still marks " + target + " " + item.detail.status + " for reason " + item.detail.reasonCode + "; do not treat it as passed.")
      const active = item.repairs.filter(repair => ACTIVE_REPAIR.has(repair.status))
      if (active.length === 1) {
        if (names.has("agent.wait")) lines.push("One matching repair is active. Use the visible agent.wait for that current repair; do not schedule a duplicate.")
        else lines.push("One matching repair is active, but no wait tool is visible. Do not schedule a duplicate; inspect current evidence if possible.")
      } else if (active.length > 1 || item.repairs.length > 1) {
        lines.push("The current graph has ambiguous matching repair attempts. Inspect current reports and do not add another attempt.")
      } else if (item.criterionId !== undefined && item.detail.reasonCode !== "repair_target_unresolved" && !omitted) {
        if (item.repairs.length === 1) lines.push("A matching repair is terminal; inspect its current report and receipt before deciding whether another attempt is valid.")
        if (item.detail.repairState === "pending") lines.push("The denial recorded a pending repair, but the current graph no longer shows it active. Refresh and inspect the current receipt; do not schedule another attempt from the old marker.")
        else if (item.repairs.length === 1 && item.repairs[0]!.status === "failed" && !item.repairs[0]!.repairReceipt) {
          if (names.has("agent.plan") && graph.mayPlan) {
            const inspect = names.has("agent.list") ? "Inspect its current result page with the visible agent.list and current evidence" : "Inspect the current graph and available evidence"
            lines.push("A matching repair failed without a receipt. " + inspect + "; only if a relevant prerequisite has changed or an explicit bounded retry rule is visible may the visible agent.plan evaluate another typed repair under expectedRevision " + graph.revision + ". Otherwise preserve the blocker. The existing planner and completion gate decide validity; capacity is advisory, including any first-repair reserve.")
          }
        } else if (item.repairs.length === 0 && names.has("agent.plan") && graph.mayPlan) {
          lines.push("If current evidence still leaves this criterion unresolved, the visible agent.plan may evaluate one typed repair under its current expectedRevision " + graph.revision + " contract. The existing planner and completion gate decide validity; capacity is advisory, including any first-repair reserve.")
        }
      }
    }
    if (names.has("agent.list")) lines.push("Use the owner-read graph for node, criterion, and revision identities; use the visible agent.list only to inspect matching current result pages. It does not refresh graph state. If a page is stale or unavailable, compare a refreshed current graph before retrying. A null cursor ends paging for that node and revision only, not task or verification completion.")
    else lines.push("No result-page tool is visible; do not infer complete results or new evidence.")
    if (!names.has("agent.plan")) lines.push("No plan command is visible; do not claim a graph change.")
    if (omitted || details.length === 0) lines.push("If no current evidence-based next action is available, preserve the blocker rather than guessing.")
    return { role: "system", content: [{ type: "text", text: lines.join(" ") }] }
  } catch { return null }
}
