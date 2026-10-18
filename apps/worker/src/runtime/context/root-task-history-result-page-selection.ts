import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import {
  TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS,
  TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA,
  TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE,
  type TaskGraphHistoricalDiscoveryAvailablePage,
  type TaskGraphHistoricalDiscoveryPage,
  type TaskGraphHistoricalDiscoveryPageRequest,
} from "../subagents/task-graph-historical-discovery-page-contract.js"
import { parseRegisteredScoutEnvelope, type RegisteredScoutEnvelope, type TaskGraphCurrentNode } from "../subagents/task-graph-command-port.js"
import { TASK_GRAPH_TEMPLATES } from "../subagents/task-graph-templates.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult, type ScoutResult } from "../subagents/role-results.js"
import type { StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"
import type { GraphTaskRow } from "../subagents/task-graph-pg-state.js"
import { isCanonicalTaskGraphJobId, TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT } from "../subagents/task-graph-result-page-contract.js"
import { parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus } from "../subagents/task-graph-command-port.js"
import { taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"

type Row = Record<string, unknown>
export type HistoricalDiscoveryTaskBinding = Readonly<{
  allowedActions: unknown
  contextIsObject: unknown
  hasPrivateSelectionContext: unknown
}>
export type HistoricalDiscoverySelection = Readonly<{
  nodeKey: string
  taskId: string
  attemptCount: number
  sourceResultStatus: "completed"
  jobIds: readonly string[]
  truncated: boolean
  resultIdsDigest: string
}>
export type HistoricalDiscoveryTokenBinding = Readonly<{
  current: Readonly<{
    userId: string
    sessionId: string
    turnId: string
    rootTaskId: string
    turnLeaseOwner: string
    turnLeaseVersion: number
    parentLeaseOwner: string
    rootAttemptCount: number
  }>
  objectiveDigest: string
  source: Readonly<{
    sessionId: string
    turnId: string
    rootTaskId: string
    terminalSequence: string
    terminalStatus: "completed" | "failed" | "interrupted"
    terminalReceiptDigest: string
    graphRevision: number
    nodeKey: string
    taskId: string
    attemptCount: number
    sourceResultStatus: "completed"
    resultIdsDigest: string
  }>
}>

const EXPECTED_SCOUT = parseRegisteredScoutEnvelope({
  role: TASK_GRAPH_TEMPLATES.scout.role,
  taskType: TASK_GRAPH_TEMPLATES.scout.taskType,
  expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema,
  allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions],
})!
const WORKER_ENVELOPE_KEYS = "finalItemId,finalText,status,stepCount,structuredResult,toolCallCount"

/** Selects only an ordinary, completed, typed Scout whose persisted policy still matches the registered template. */
export function selectOrdinaryHistoricalScout(
  node: StoredTaskGraphNode,
  current: TaskGraphCurrentNode | undefined,
  task: GraphTaskRow | undefined,
  binding: HistoricalDiscoveryTaskBinding | undefined,
): HistoricalDiscoverySelection | undefined {
  if (!current || !task || !binding || node.templateId !== "scout" || node.verificationDisposition !== "typed"
    || node.repairOf || Object.hasOwn(node, "nativeDelegation") || current.native || current.nativeResult
    || current.key !== node.key || current.taskId !== node.taskId || current.templateId !== "scout"
    || current.status !== "completed" || task.id !== node.taskId || task.status !== "completed"
    || task.role !== "scout" || task.taskType !== "job_discovery" || !validAttempt(task.attemptCount)
    || binding.contextIsObject !== true || binding.hasPrivateSelectionContext !== false
    || !sameScoutEnvelope(node.registeredScoutEnvelope, EXPECTED_SCOUT)
    || !sameOutputMarker(task.expectedOutputSchema) || !sameActions(binding.allowedActions, EXPECTED_SCOUT.allowedActions)
    || current.verificationReport?.status !== "passed") return undefined

  const result = parseCompletedScoutResult(node, task.result, current)
  if (!result || !projectionMatchesScout(current)) return undefined
  const ids: string[] = [], seen = new Set<string>()
  for (const candidate of result.candidates) {
    if (!isCanonicalTaskGraphJobId(candidate.jobId)) return undefined
    if (!seen.has(candidate.jobId)) {
      seen.add(candidate.jobId)
      ids.push(candidate.jobId)
    }
  }
  if (ids.length === 0) return undefined
  return {
    nodeKey: node.key,
    taskId: node.taskId,
    attemptCount: task.attemptCount!,
    sourceResultStatus: "completed",
    jobIds: ids.slice(0, TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS),
    truncated: ids.length > TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS,
    resultIdsDigest: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
  }
}

export function historicalDiscoverySourceToken(binding: HistoricalDiscoveryTokenBinding): string {
  return createHash("sha256").update(JSON.stringify({
    version: "agent-harness.v2.task-graph.historical-discovery-source.v1",
    current: binding.current,
    objectiveDigest: binding.objectiveDigest,
    source: binding.source,
  })).digest("hex")
}

export function pageForHistoricalDiscoverySelection(
  selection: HistoricalDiscoverySelection,
  tokenBinding: HistoricalDiscoveryTokenBinding,
  request: TaskGraphHistoricalDiscoveryPageRequest,
): TaskGraphHistoricalDiscoveryPage {
  const sourceToken = historicalDiscoverySourceToken(tokenBinding)
  if (request.sourceToken !== undefined && request.sourceToken !== sourceToken
    || request.offset > 0 && request.sourceToken !== sourceToken) return unavailable("source_changed")
  if (!Number.isSafeInteger(request.offset) || request.offset < 0
    || request.offset % TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE !== 0
    || request.offset >= selection.jobIds.length) return unavailable("offset_out_of_range")
  const items = selection.jobIds.slice(request.offset, request.offset + TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE)
  const nextOffset = request.offset + items.length < selection.jobIds.length ? request.offset + items.length : null
  const page: TaskGraphHistoricalDiscoveryAvailablePage = {
    schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA,
    trust: "untrusted",
    availability: "available",
    observation: "historical_discovery",
    verificationStatus: "unverified",
    sourceToken,
    sourceResultStatus: selection.sourceResultStatus,
    offset: request.offset,
    nextOffset,
    totalCount: selection.jobIds.length,
    truncated: selection.truncated,
    items: items.map(jobId => ({ jobId })),
  }
  return page
}

export function unavailableHistoricalDiscoveryPage(reason: "no_source" | "source_changed" | "offset_out_of_range"): TaskGraphHistoricalDiscoveryPage {
  return unavailable(reason)
}

function unavailable(reason: "no_source" | "source_changed" | "offset_out_of_range"): TaskGraphHistoricalDiscoveryPage {
  return { schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
    observation: "historical_discovery", verificationStatus: "unverified", reason }
}

type CompletedScoutResult = Omit<ScoutResult, "status"> & Readonly<{ status: "completed" }>

function parseCompletedScoutResult(node: StoredTaskGraphNode, value: unknown, current: TaskGraphCurrentNode): CompletedScoutResult | undefined {
  const stored = plainRecord(value)
  if (!stored || !Object.hasOwn(stored, "taskGraphVerificationReport") || Object.hasOwn(stored, "taskGraphRepairReceipt")) return undefined
  const { taskGraphVerificationReport: _validatedReport, ...envelope } = stored
  if (Object.keys(envelope).sort().join(",") !== WORKER_ENVELOPE_KEYS || envelope.status !== "completed"
    || !Number.isSafeInteger(envelope.stepCount) || Number(envelope.stepCount) < 0
    || !Number.isSafeInteger(envelope.toolCallCount) || Number(envelope.toolCallCount) < 0
    || (envelope.finalItemId !== null && typeof envelope.finalItemId !== "string") || typeof envelope.finalText !== "string"
    || !Object.hasOwn(envelope, "structuredResult")) return undefined
  let bytes: number
  try { bytes = Buffer.byteLength(JSON.stringify(envelope.structuredResult), "utf8") } catch { return undefined }
  if (bytes > TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT || current.verificationReport?.status !== "passed"
    || !node.verification || node.verificationDisposition !== "typed") return undefined
  const criterionIds = node.verification.criteria.map(criterion => criterion.id)
  const report = parseTaskGraphVerificationReport(_validatedReport, criterionIds)
  if (!report || JSON.stringify(report) !== JSON.stringify(current.verificationReport)
    || !taskGraphVerificationReportMatchesStatus(report, "completed")) return undefined
  try {
    const result = validateRoleResult(envelope.structuredResult, "scout")
    if (result.role !== "scout" || result.status !== "completed" || taskGraphResultDigest(result) !== report.resultDigest) return undefined
    return { ...result, status: "completed" }
  } catch { return undefined }
}

function plainRecord(value: unknown): Row | undefined {
  let parsed = value
  if (typeof value === "string") { try { parsed = JSON.parse(value) as unknown } catch { return undefined } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try {
    const prototype = Object.getPrototypeOf(parsed)
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(parsed).length > 0) return undefined
    return parsed as Row
  } catch { return undefined }
}

function sameOutputMarker(value: unknown): boolean {
  const row = plainRecord(value)
  return Boolean(row && Object.keys(row).sort().join(",") === "role,schemaVersion"
    && row.role === "scout" && row.schemaVersion === ROLE_RESULT_SCHEMA)
}

function sameScoutEnvelope(value: unknown, expected: RegisteredScoutEnvelope): boolean {
  const actual = parseRegisteredScoutEnvelope(value)
  return Boolean(actual && actual.role === expected.role && actual.taskType === expected.taskType
    && actual.expectedOutputSchema.role === expected.expectedOutputSchema.role
    && actual.expectedOutputSchema.schemaVersion === expected.expectedOutputSchema.schemaVersion
    && sameActions(actual.allowedActions, expected.allowedActions))
}

function sameActions(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value)) return false
  try {
    const keys = Reflect.ownKeys(value)
    if (value.length !== expected.length || keys.length !== value.length + 1 || !keys.includes("length")) return false
    return expected.every((action, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      return Boolean(descriptor?.enumerable && "value" in descriptor && descriptor.value === action)
    })
  } catch { return false }
}

function validAttempt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }

function projectionMatchesScout(current: TaskGraphCurrentNode): boolean {
  const projection = current.resultProjection
  if (!projection) return false
  return projection.availability === "unavailable"
    || projection.role === "scout" && projection.status === "completed"
}
