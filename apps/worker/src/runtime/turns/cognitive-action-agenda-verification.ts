import type { StepContext } from "../context/step-context-builder.js"
import type { TaskGraphReadiness } from "../planning/task-graph.js"
import { nativeGraphNodeFields } from "../canonical-turn-native-graph-context.js"
import { parseTaskGraphCurrentVerificationMetadata, validateTaskGraphCurrentVerificationGraph } from "../canonical-turn-task-graph-verification-context.js"
import { taskGraphVerificationReportMatchesStatus, type TaskGraphCurrentNode } from "../subagents/task-graph-command-port.js"
import type { SubagentTaskStatus } from "../subagents/types.js"

const CURRENT_BLOCK_ID = "observation:task-graph-current"
const CURRENT_BLOCK_KIND = "task_graph_current"
const MAX_CONTEXT_BLOCKS = 512
const MAX_CURRENT_NODES = 16
const MAX_RECORD_KEYS = 32
const STATUSES = new Set<SubagentTaskStatus>(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const READINESS = new Set<TaskGraphReadiness>(["ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal"])

type Row = Record<string, unknown>

function dataRecord(value: unknown): Row | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length > MAX_RECORD_KEYS || keys.some(key => typeof key !== "string")) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const output: Row = {}
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
      Object.defineProperty(output, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true })
    }
    return output
  } catch { return undefined }
}

function denseArray(value: unknown, minimum: number, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
    const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Row
    const length = (descriptors.length as PropertyDescriptor | undefined)?.value
    if (!Number.isSafeInteger(length) || Number(length) < minimum || Number(length) > maximum || keys.length !== Number(length) + 1
      || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)))) return undefined
    const output: unknown[] = []
    for (let index = 0; index < Number(length); index += 1) {
      const descriptor = descriptors[String(index)] as PropertyDescriptor | undefined
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
      output.push(descriptor.value)
    }
    return output
  } catch { return undefined }
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value
}

function prose(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
}

function stringList(value: unknown, minimum: number, maximum: number, itemLength: number, allowProsePadding = false): string[] | undefined {
  const items = denseArray(value, minimum, maximum)
  if (!items || !items.every(item => allowProsePadding ? prose(item, itemLength) : text(item, itemLength))) return undefined
  return items as string[]
}

function currentNode(value: unknown): TaskGraphCurrentNode | undefined {
  const row = dataRecord(value)
  if (!row || !text(row.key, 128) || !text(row.taskId, 128) || !text(row.templateId, 128) || !prose(row.goal, 1200)
    || !text(row.status, 32) || !STATUSES.has(row.status as SubagentTaskStatus)
    || !text(row.readiness, 32) || !READINESS.has(row.readiness as TaskGraphReadiness)
    || row.resultSummary !== null || row.failureReason !== null) return undefined
  const successCriteria = stringList(row.successCriteria, 1, 8, 320, true)
  const dependsOn = stringList(row.dependsOn, 0, MAX_CURRENT_NODES, 128)
  const verification = parseTaskGraphCurrentVerificationMetadata(row, row.templateId, row.key, row.taskId)
  if (!successCriteria || !dependsOn || !verification) return undefined
  try {
    return { key: row.key, taskId: row.taskId, templateId: row.templateId, goal: row.goal,
      successCriteria, dependsOn, status: row.status as SubagentTaskStatus,
      readiness: row.readiness as TaskGraphReadiness, resultSummary: null, failureReason: null,
      ...verification, ...nativeGraphNodeFields(row) }
  } catch { return undefined }
}

function currentNodes(context: StepContext): readonly TaskGraphCurrentNode[] | undefined {
  const contextRow = dataRecord(context)
  if (!contextRow || !Number.isSafeInteger(contextRow.taskGraphRevision) || Number(contextRow.taskGraphRevision) < 0) return undefined
  const blocks = denseArray(contextRow.blocks, 0, MAX_CONTEXT_BLOCKS)
  if (!blocks) return undefined
  const current: Row[] = []
  for (const value of blocks) {
    const block = dataRecord(value)
    if (!block || typeof block.id !== "string") return undefined
    if (block.id === CURRENT_BLOCK_ID) current.push(block)
  }
  if (current.length !== 1) return undefined
  const block = current[0]!
  if (block.layer !== "tool_observation" || block.role !== "data" || block.trust !== "external_untrusted" || block.source !== "tool_or_subagent") return undefined
  const graph = dataRecord(block.content)
  if (!graph || graph.kind !== CURRENT_BLOCK_KIND || graph.revision !== contextRow.taskGraphRevision) return undefined
  const values = denseArray(graph.nodes, 0, MAX_CURRENT_NODES)
  if (!values) return undefined
  const nodes = values.map(currentNode)
  if (nodes.some(node => !node)) return undefined
  const parsed = nodes as TaskGraphCurrentNode[]
  return validateTaskGraphCurrentVerificationGraph(parsed) ? parsed : undefined
}

/** Counts only explicit non-passing rows from the unique current canonical graph block. */
export function countCurrentTypedVerificationCriteria(context: StepContext): number {
  try {
    const nodes = currentNodes(context)
    if (!nodes) return 0
    let count = 0
    for (const node of nodes) {
      if (node.status !== "failed" || node.templateId !== "scout" && node.templateId !== "analyst"
        || node.native || node.nativeResult || !node.verification || !node.verificationReport) continue
      if (node.readiness !== "terminal") return 0
      if (!taskGraphVerificationReportMatchesStatus(node.verificationReport, node.status)) return 0
      count += node.verificationReport.criteria.filter(item => item.status === "failed" || item.status === "unverified").length
    }
    return Number.isSafeInteger(count) && count <= 999 ? count : 0
  } catch { return 0 }
}
