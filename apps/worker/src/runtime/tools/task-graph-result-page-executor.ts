import { types as nodeTypes } from "node:util"
import { CoordinationError } from "./coordination-types.js"
import { executeListSubagents } from "./coordination-executors.js"
import type { CoordinationExecutorOptions } from "./coordination-executors.js"
import type { ListSubagentsInput } from "./coordination-tools.js"
import type { ToolExecutionContext } from "./types.js"
import { activity } from "./coordination-executor-support.js"
import { parseTaskGraphResultPage, parseTaskGraphResultPageRequest, type TaskGraphResultPage, type TaskGraphResultPageRequest } from "../subagents/task-graph-result-page-contract.js"
import {
  TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA,
  parseTaskGraphHistoricalDiscoveryPage,
  parseTaskGraphHistoricalDiscoveryPageRequest,
  type TaskGraphHistoricalDiscoveryPage,
  type TaskGraphHistoricalDiscoveryPageRequest,
} from "../subagents/task-graph-historical-discovery-page-contract.js"
import {
  parseTaskGraphDiscoveryRecoveryPage,
  parseTaskGraphDiscoveryRecoveryPageRequest,
  type TaskGraphDiscoveryRecoveryPage,
  type TaskGraphDiscoveryRecoveryPageRequest,
} from "../subagents/task-graph-discovery-recovery-page-contract.js"
import type { TaskGraphCommandPort, TaskGraphExecutionScope, TaskGraphReadScope } from "../subagents/task-graph-command-port.js"

type HistoricalDiscoveryReader = {
  readHistoricalDiscoveryPage?: (scope: TaskGraphExecutionScope, request: TaskGraphHistoricalDiscoveryPageRequest) => Promise<unknown>
}

/** Canonical agent.list dispatch keeps legacy input exact and never falls back from a malformed page mode. */
export async function executeAgentList(context: ToolExecutionContext, input: unknown, options: CoordinationExecutorOptions): Promise<unknown> {
  const mode = readMode(input)
  if (mode === "historical_discovery") {
    const request = parseTaskGraphHistoricalDiscoveryPageRequest(input)
    if (!request) invalidInput()
    return executeHistoricalDiscoveryPage(context, request, options)
  }
  if (mode === "discovery_recovery") {
    const request = parseTaskGraphDiscoveryRecoveryPageRequest(input)
    if (!request) invalidInput()
    return executeTaskGraphDiscoveryRecoveryPage(context, request, options)
  }
  const request = parseTaskGraphResultPageRequest(input)
  if (request) return executeTaskGraphResultPage(context, request, options)
  const legacy = parseLegacyListInput(input)
  if (legacy) return executeListSubagents(context, legacy, options)
  invalidInput()
}

async function executeHistoricalDiscoveryPage(
  context: ToolExecutionContext,
  request: TaskGraphHistoricalDiscoveryPageRequest,
  options: CoordinationExecutorOptions,
): Promise<TaskGraphHistoricalDiscoveryPage> {
  const native = options.nativeCoordination
  const port = native?.commandPort as (TaskGraphCommandPort & HistoricalDiscoveryReader) | undefined
  if (!native?.enabled || context.actorRole !== "orchestrator" || !nonempty(context.taskId)
    || context.taskId !== context.rootTaskId || !port || typeof port.readHistoricalDiscoveryPage !== "function") unavailable()
  const parentAttemptCount = readParentAttempt(native.parentAttemptCount)
  const scope = historicalPageReadScope(context, native.turnLeaseOwner, native.turnLeaseVersion, native.parentLeaseOwner, parentAttemptCount)
  const parsed = parseTaskGraphHistoricalDiscoveryPage(await port.readHistoricalDiscoveryPage(scope, request))
  if (!parsed) invalidPage("Historical TaskGraph discovery page is invalid")
  if (parsed.availability === "available" && parsed.offset !== request.offset) invalidPage("Historical TaskGraph discovery page is invalid")
  const page = parsed.availability === "available" && request.sourceToken !== undefined && parsed.sourceToken !== request.sourceToken
    ? historicalUnavailable("source_changed") : parsed
  await activity(context, options, "agent.list_historical_discovery_page", null, {
    count: page.availability === "available" ? page.items.length : 0, offset: request.offset,
  })
  return page
}

async function executeTaskGraphDiscoveryRecoveryPage(
  context: ToolExecutionContext,
  request: TaskGraphDiscoveryRecoveryPageRequest,
  options: CoordinationExecutorOptions,
): Promise<TaskGraphDiscoveryRecoveryPage> {
  const native = options.nativeCoordination
  const port = native?.commandPort
  if (!native?.enabled || context.actorRole !== "orchestrator" || !nonempty(context.taskId)
    || context.taskId !== context.rootTaskId || !port || typeof port.readCurrentDiscoveryRecoveryPage !== "function") unavailable()
  const parentAttemptCount = readParentAttempt(native.parentAttemptCount)
  const scope = pageReadScope(context, native.turnLeaseOwner, native.turnLeaseVersion, native.parentLeaseOwner, parentAttemptCount)
  const page = parseTaskGraphDiscoveryRecoveryPage(await port.readCurrentDiscoveryRecoveryPage(scope, request))
  if (!page || page.availability === "available" && (page.graphRevision !== request.expectedRevision || page.offset !== request.offset
    || request.expectedAttemptCount !== undefined && page.attemptCount !== request.expectedAttemptCount)) {
    invalidPage("TaskGraph discovery recovery page is invalid")
  }
  await activity(context, options, "agent.list_discovery_recovery_page", null, {
    count: page.availability === "available" ? page.items.length : 0, revision: page.graphRevision,
  })
  return page
}

async function executeTaskGraphResultPage(context: ToolExecutionContext, request: TaskGraphResultPageRequest, options: CoordinationExecutorOptions): Promise<TaskGraphResultPage> {
  const native = options.nativeCoordination
  const port = native?.commandPort
  if (!native?.enabled || context.actorRole !== "orchestrator" || !nonempty(context.taskId)
    || context.taskId !== context.rootTaskId || !port || typeof port.readCurrentResultPage !== "function") unavailable()
  const parentAttemptCount = readParentAttempt(native.parentAttemptCount)
  const scope = pageReadScope(context, native.turnLeaseOwner, native.turnLeaseVersion, native.parentLeaseOwner, parentAttemptCount)
  const page = parseTaskGraphResultPage(await port.readCurrentResultPage(scope, request))
  if (!page || page.availability === "available" && (page.graphRevision !== request.expectedRevision || page.offset !== request.offset)) {
    invalidPage("TaskGraph result page is invalid")
  }
  await activity(context, options, "agent.list_page", null, {
    count: page.availability === "available" ? page.items.length : 0, revision: page.graphRevision,
  })
  return page
}

function parseLegacyListInput(value: unknown): ListSubagentsInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => key !== "includeTerminal")) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, "includeTerminal")
    if (!descriptor) return {}
    if (!descriptor.enumerable || !("value" in descriptor)
      || descriptor.value !== undefined && typeof descriptor.value !== "boolean") return null
    return descriptor.value === undefined ? {} : { includeTerminal: descriptor.value }
  } catch { return null }
}

function readMode(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, "mode")
    return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}

function readParentAttempt(read: () => number | null | undefined): number {
  let value: number | null | undefined
  try { value = read() } catch { return unavailable() }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return unavailable()
  return value
}

function pageReadScope(context: ToolExecutionContext, turnLeaseOwner: string, turnLeaseVersion: number,
  parentLeaseOwner: string, parentAttemptCount: number): TaskGraphReadScope {
  if (![context.scope.userId, context.sessionId, context.turnId, context.stepId, turnLeaseOwner, parentLeaseOwner].every(nonempty)
    || !Number.isSafeInteger(turnLeaseVersion) || turnLeaseVersion < 1) return unavailable()
  return { userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId,
    rootTaskId: context.taskId!, parentTaskId: context.taskId!, turnLeaseOwner, turnLeaseVersion, parentLeaseOwner, parentAttemptCount }
}

function historicalPageReadScope(context: ToolExecutionContext, turnLeaseOwner: string, turnLeaseVersion: number,
  parentLeaseOwner: string, parentAttemptCount: number): TaskGraphExecutionScope {
  if (![context.scope.userId, context.sessionId, context.turnId, context.stepId, turnLeaseOwner, parentLeaseOwner].every(nonempty)
    || !Number.isSafeInteger(turnLeaseVersion) || turnLeaseVersion < 1) return unavailable()
  return { userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
    rootTaskId: context.taskId!, parentTaskId: context.taskId!, turnLeaseOwner, turnLeaseVersion, parentLeaseOwner, parentAttemptCount }
}

function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function invalidInput(): never { throw new CoordinationError("coordination_invalid_input", "Invalid agent.list input") }
function invalidPage(message: string): never { throw new CoordinationError("coordination_task_graph_page_invalid", message) }
function unavailable(): never {
  throw new CoordinationError("coordination_task_graph_page_unavailable", "Current TaskGraph result pages are unavailable")
}

function historicalUnavailable(reason: "no_source" | "source_changed" | "offset_out_of_range"): TaskGraphHistoricalDiscoveryPage {
  return { schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
    observation: "historical_discovery", verificationStatus: "unverified", reason }
}
