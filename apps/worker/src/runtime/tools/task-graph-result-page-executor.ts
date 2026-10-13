import { types as nodeTypes } from "node:util"
import { CoordinationError } from "./coordination-types.js"
import { executeListSubagents } from "./coordination-executors.js"
import type { CoordinationExecutorOptions } from "./coordination-executors.js"
import type { ListSubagentsInput } from "./coordination-tools.js"
import type { ToolExecutionContext } from "./types.js"
import { activity } from "./coordination-executor-support.js"
import { parseTaskGraphResultPage, parseTaskGraphResultPageRequest, type TaskGraphResultPage, type TaskGraphResultPageRequest } from "../subagents/task-graph-result-page-contract.js"
import type { TaskGraphReadScope } from "../subagents/task-graph-command-port.js"

/** Canonical agent.list dispatch keeps legacy input exact and never falls back from a malformed page. */
export async function executeAgentList(context: ToolExecutionContext, input: unknown, options: CoordinationExecutorOptions): Promise<unknown> {
  const request = parseTaskGraphResultPageRequest(input)
  if (request) return executeTaskGraphResultPage(context, request, options)
  const legacy = parseLegacyListInput(input)
  if (legacy) return executeListSubagents(context, legacy, options)
  throw new CoordinationError("coordination_invalid_input", "Invalid agent.list input")
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
    throw new CoordinationError("coordination_task_graph_page_invalid", "TaskGraph result page is invalid")
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

function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function unavailable(): never {
  throw new CoordinationError("coordination_task_graph_page_unavailable", "Current TaskGraph result pages are unavailable")
}
