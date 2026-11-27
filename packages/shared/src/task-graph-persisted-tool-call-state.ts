import { isDeepStrictEqual } from "node:util"

type Row = Record<string, unknown>
export type TaskGraphToolObservation = { readonly id: string; readonly content: Record<string, unknown> }
export type TaskGraphToolResult = { readonly id: string; readonly toolName: string; readonly toolVersion: string; readonly status: "completed" | "failed" | "cancelled"; readonly output?: unknown; readonly errorCode: string | null }
export type TaskGraphPersistedToolCallRecovery = {
  readonly call: { readonly id: string; readonly name: string; readonly arguments: unknown }
  readonly toolVersion: string
  readonly stepId: string
  readonly callItem: { readonly id: string; readonly revision: number }
  readonly resultItem?: { readonly id: string; readonly revision: number }
  readonly durableResult?: TaskGraphToolResult
}
type TerminalReceipt = { readonly result: TaskGraphToolResult; readonly hasErrorCode: boolean; readonly errorCodeValue?: unknown }

function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {} }
function payload(value: unknown): Row { const row = object(value); return object(row.payload ?? row) }
function validStatus(value: unknown): boolean { return value === undefined || value === null || ["started", "streaming", "completed", "failed", "interrupted"].includes(String(value)) }
function terminalStatus(value: unknown): boolean { return value === "completed" || value === "failed" }
function nonEmptyString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined }

function terminalResultStatus(eventType: unknown, value: unknown): TaskGraphToolResult["status"] {
  if (value === undefined || value === null) return eventType === "tool_call.completed" ? "completed" : "failed"
  if (eventType === "tool_call.completed" && value === "completed") return "completed"
  if (eventType === "tool_call.failed" && (value === "failed" || value === "cancelled")) return value
  throw new Error("tool_result_replay_uncertain")
}

function assertConsistentReceipt(previous: TaskGraphToolResult, next: TaskGraphToolResult, data: Row): void {
  if (previous.status !== next.status) throw new Error("tool_result_replay_uncertain")
  const previousVersion = nonEmptyString(previous.toolVersion), nextVersion = nonEmptyString(data.toolVersion)
  if (previousVersion && nextVersion && previousVersion !== nextVersion) throw new Error("tool_result_replay_uncertain")
  if (Object.prototype.hasOwnProperty.call(data, "output") && "output" in previous && !isDeepStrictEqual(previous.output, data.output)) {
    throw new Error("tool_result_replay_uncertain")
  }
  const previousError = nonEmptyString(previous.errorCode), nextError = nonEmptyString(data.errorCode)
  if (previousError && nextError && previousError !== nextError) throw new Error("tool_result_replay_uncertain")
}

function assertExplicitErrorCodeMatch(receipt: TerminalReceipt, content: Row): void {
  if (receipt.hasErrorCode && Object.prototype.hasOwnProperty.call(content, "errorCode")
    && !isDeepStrictEqual(receipt.errorCodeValue, content.errorCode)) throw new Error("tool_result_replay_uncertain")
}

function persistedOutcomeStatus(callItem: Row, call: Row, resultItem: Row | undefined): TaskGraphToolResult["status"] | undefined {
  const callStatus = call.status === "completed" || call.status === "failed" || call.status === "cancelled" ? call.status : undefined
  const resultContent = object(resultItem?.content)
  const resultStatus = resultContent.status === "completed" || resultContent.status === "failed" || resultContent.status === "cancelled" ? resultContent.status : undefined
  if (callStatus && resultStatus && callStatus !== resultStatus) throw new Error("tool_result_replay_uncertain")
  const contentStatus = callStatus ?? resultStatus
  if (contentStatus === "cancelled") return "cancelled"
  const failureStatus = callItem.status === "failed" || resultItem?.status === "failed" || Boolean(nonEmptyString(resultContent.errorCode))
    ? "failed"
    : undefined
  if (contentStatus && failureStatus && contentStatus !== failureStatus) throw new Error("tool_result_replay_uncertain")
  return contentStatus ?? failureStatus
}

function assertResultItemMatchesEvent(receipt: TerminalReceipt, resultItem: Row): void {
  const content = object(resultItem.content)
  const result = receipt.result
  const storedOutput = content.output
  const outputIsReferenceOnly = content.outputAvailable === true && (storedOutput === undefined || storedOutput === null)
  if (Object.prototype.hasOwnProperty.call(content, "output") && !outputIsReferenceOnly && "output" in result
    && !isDeepStrictEqual(storedOutput, result.output)) throw new Error("tool_result_replay_uncertain")
  const storedError = nonEmptyString(content.errorCode), eventError = nonEmptyString(result.errorCode)
  if (storedError && eventError && storedError !== eventError) throw new Error("tool_result_replay_uncertain")
  assertExplicitErrorCodeMatch(receipt, content)
}

function finalResults(events: readonly Row[], calls: ReadonlyMap<string, Row>): Map<string, TerminalReceipt> {
  const results = new Map<string, TerminalReceipt>()
  for (const event of events) {
    if (event.type !== "tool_call.completed" && event.type !== "tool_call.failed") continue
    const data = payload(event.payload)
    if (typeof data.toolCallId !== "string") continue
    const callItem = calls.get(data.toolCallId)
    if (!callItem) continue
    const call = object(callItem.content)
    if (Object.prototype.hasOwnProperty.call(data, "failureKind")) {
      if (event.type !== "tool_call.failed" || (data.status !== "failed" && data.status !== "cancelled")) throw new Error("tool_result_replay_uncertain")
      if (data.failureKind === "diagnostic") {
        if (data.output !== null || !Object.prototype.hasOwnProperty.call(data, "failureDetail")) throw new Error("tool_result_replay_uncertain")
      } else if (data.failureKind !== "safe_output" || !Object.prototype.hasOwnProperty.call(data, "output")) throw new Error("tool_result_replay_uncertain")
    }
    if (typeof call.toolName !== "string") continue
    if (typeof data.toolName === "string" && data.toolName !== call.toolName) throw new Error("tool_result_replay_uncertain")
    const previousReceipt = results.get(data.toolCallId)
    const previous = previousReceipt?.result
    const status = terminalResultStatus(event.type, data.status)
    const persistedStatus = persistedOutcomeStatus(callItem, call, undefined)
    if (persistedStatus && persistedStatus !== status) throw new Error("tool_result_replay_uncertain")
    const version = nonEmptyString(data.toolVersion) ?? previous?.toolVersion ?? nonEmptyString(call.toolVersion) ?? "1"
    const errorCode = nonEmptyString(data.errorCode) ?? previous?.errorCode ?? null
    const next: TaskGraphToolResult = {
      id: data.toolCallId, toolName: call.toolName, toolVersion: version, status,
      ...(Object.prototype.hasOwnProperty.call(data, "output") ? { output: data.output } : previous && "output" in previous ? { output: previous.output } : {}),
      errorCode,
    }
    if (previous) assertConsistentReceipt(previous, next, data)
    const currentHasErrorCode = Object.prototype.hasOwnProperty.call(data, "errorCode")
    if (previousReceipt && currentHasErrorCode && previousReceipt.hasErrorCode
      && !isDeepStrictEqual(previousReceipt.errorCodeValue, data.errorCode)) throw new Error("tool_result_replay_uncertain")
    const hasErrorCode = currentHasErrorCode || Boolean(previousReceipt?.hasErrorCode)
    const errorCodeValue = currentHasErrorCode ? data.errorCode : previousReceipt?.errorCodeValue
    results.set(data.toolCallId, { result: next, hasErrorCode, ...(hasErrorCode ? { errorCodeValue } : {}) })
  }
  return results
}

function exactKeys(row: Row, keys: readonly string[]): boolean { const actual = Object.keys(row); return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(row, key)) }
function messageDiagnostic(value: unknown): boolean {
  const row = object(value)
  return exactKeys(row, ["message"]) && typeof row.message === "string"
}
function legacyDiagnosticEvents(events: readonly Row[], calls: ReadonlyMap<string, Row>, results: ReadonlyMap<string, Row>): Row[] {
  const candidates = new Map<string, Row[]>()
  for (const event of events) {
    const data = payload(event.payload), callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined
    if (!callId || Object.prototype.hasOwnProperty.call(data, "failureKind") || event.type !== "tool_call.failed"
      || event.itemId != null || !messageDiagnostic(data.output)) continue
    candidates.set(callId, [...candidates.get(callId) ?? [], event])
  }
  const projected = new Map<Row, Row>()
  for (const [callId, rows] of candidates) {
    const callItem = calls.get(callId), resultItem = results.get(callId), result = object(resultItem?.content)
    if (resultItem && Object.prototype.hasOwnProperty.call(result, "output") && result.output !== null) continue
    if (!callItem) continue
    const origins = rows.map(event => ({ event, phase: legacyLifecycleOrigin(event, nonEmptyString(event.taskId) ?? "", callId) }))
      .filter((entry): entry is { event: Row; phase: "failed" | "cancelled" } => entry.phase !== undefined)
    if (origins.length === 0 || !resultItem) throw new Error("tool_result_replay_uncertain")
    const { event, phase } = origins[0]!
    if (rows.length !== 1) throw new Error("tool_result_replay_uncertain")
    const data = payload(event.payload), call = object(callItem.content), taskId = callItem.taskId
    const errorCode = nonEmptyString(data.errorCode), callVersion = call.toolVersion === undefined ? "1" : nonEmptyString(call.toolVersion)
    if (!Object.prototype.hasOwnProperty.call(result, "output") || result.outputAvailable !== undefined && result.outputAvailable !== false
      || result.output !== null || callItem.status !== "completed" || resultItem.status !== "completed"
      || typeof callItem.id !== "string" || !callItem.id || typeof resultItem.id !== "string" || !resultItem.id || callItem.id === resultItem.id
      || typeof callItem.stepId !== "string" || !callItem.stepId || resultItem.stepId !== callItem.stepId
      || typeof taskId !== "string" || !taskId || resultItem.taskId !== taskId
      || call.toolCallId !== callId || result.toolCallId !== callId || event.taskId !== taskId
      || !exactKeys(data, ["toolCallId", "toolName", "toolVersion", "status", "output", "errorCode"]) || data.status !== phase || call.status !== phase
      || (result.status !== undefined && result.status !== phase) || !errorCode
      || call.errorCode !== errorCode || result.errorCode !== errorCode || data.toolName !== call.toolName
      || !callVersion || data.toolVersion !== callVersion) {
      throw new Error("tool_result_replay_uncertain")
    }
    const payloadWithoutDiagnostic = { ...data }
    delete payloadWithoutDiagnostic.output
    projected.set(event, { ...event, payload: payloadWithoutDiagnostic })
  }
  return events.map(event => projected.get(event) ?? event)
}
function legacyLifecycleOrigin(event: Row, taskId: string, callId: string): "failed" | "cancelled" | undefined {
  const kind = event.actor === "orchestrator" ? "turn" : event.actor === "subagent" ? "task" : undefined
  if (!kind || !taskId || event.type !== "tool_call.failed" || event.taskId !== taskId || event.itemId !== null
    || event.causationId !== null || event.correlationId !== callId) return undefined
  for (const phase of ["failed", "cancelled"] as const) {
    const prefix = `tool-lifecycle:${kind}:${taskId}:${callId}:${phase}:`, id = event.id
    if (typeof id !== "string" || !id.startsWith(prefix)) continue
    const digest = id.slice(prefix.length)
    if (/^[a-f0-9]{24}$/.test(digest)
      && event.idempotencyKey === `${kind}:${taskId}:tool-lifecycle:${callId}:${phase}:${digest}`) return phase
  }
  return undefined
}

function itemResult(callId: string, toolName: string, call: Row, result: Row): TaskGraphToolResult {
  const content = object(result.content)
  const status = call.status === "cancelled" || content.status === "cancelled" ? "cancelled"
    : call.status === "failed" || content.errorCode ? "failed" : "completed"
  return {
    id: callId, toolName, toolVersion: typeof call.toolVersion === "string" ? call.toolVersion : "1", status,
    ...(Object.prototype.hasOwnProperty.call(content, "output") ? { output: content.output } : { output: null }),
    errorCode: typeof content.errorCode === "string" ? content.errorCode : null,
  }
}

function validHandle(item: Row): { id: string; revision: number } | null {
  return typeof item.id === "string" && item.id.length > 0 && Number.isSafeInteger(Number(item.revision))
    ? { id: item.id, revision: Number(item.revision) }
    : null
}

export function restoreToolCallState(items: readonly Record<string, unknown>[], events: readonly Record<string, unknown>[], options?: {
  readonly resolveMarkedResult: (input: { callId: string; callItem: Row; resultItem?: Row; durableResult?: TaskGraphToolResult }) => TaskGraphToolResult | undefined
}): {
  readonly observations: readonly TaskGraphToolObservation[]
  readonly pending: readonly TaskGraphPersistedToolCallRecovery[]
} {
  const calls = new Map<string, Row>()
  const results = new Map<string, Row>()
  for (const item of items) {
    const content = object(item.content)
    const hasMarker = Object.prototype.hasOwnProperty.call(content, "dependencyWaitBatchRejection")
    if (hasMarker && (item.type !== "tool_call" || !options || typeof content.toolCallId !== "string")) throw new Error("tool_result_replay_uncertain")
    if (item.type !== "tool_call" && item.type !== "tool_result") continue
    const callId = content.toolCallId
    if (typeof callId !== "string") continue
    const map = item.type === "tool_call" ? calls : results
    if (map.has(callId)) throw new Error("tool_result_replay_uncertain")
    map.set(callId, item)
  }
  const finalByCall = finalResults(legacyDiagnosticEvents(events, calls, results), calls)
  const pending: TaskGraphPersistedToolCallRecovery[] = []
  const pendingIds = new Set<string>()
  for (const [callId, callItem] of calls) {
    const call = object(callItem.content)
    const resultItem = results.get(callId)
    if (!validStatus(callItem.status) || (resultItem && !validStatus(resultItem.status))) throw new Error("tool_result_replay_uncertain")
    if (resultItem && terminalStatus(callItem.status) && terminalStatus(resultItem.status) && callItem.status !== resultItem.status) throw new Error("tool_result_replay_uncertain")
    const durableReceipt = finalByCall.get(callId)
    const durableResult = options?.resolveMarkedResult({ callId, callItem, resultItem, durableResult: durableReceipt?.result }) ?? durableReceipt?.result
    const persistedStatus = persistedOutcomeStatus(callItem, call, resultItem)
    if (durableResult && persistedStatus && durableResult.status !== persistedStatus) throw new Error("tool_result_replay_uncertain")
    if (durableReceipt && resultItem) assertResultItemMatchesEvent(durableReceipt, resultItem)
    const legacyPair = Boolean(resultItem) && callItem.status == null && resultItem?.status == null && (call.status === "completed" || call.status === "failed")
    if ((callItem.status == null || (resultItem && resultItem.status == null)) && !legacyPair && !durableResult) throw new Error("tool_result_replay_uncertain")
    const complete = Boolean(resultItem) && ((terminalStatus(callItem.status) && terminalStatus(resultItem?.status)) || legacyPair)
    if (complete) continue
    if (typeof call.toolName !== "string") throw new Error("tool_result_replay_uncertain")
    const callHandle = validHandle(callItem)
    if (!callHandle || typeof callItem.stepId !== "string" || !callItem.stepId) throw new Error("tool_result_replay_uncertain")
    const resultHandle = resultItem ? validHandle(resultItem) : null
    if (resultItem && !resultHandle) throw new Error("tool_result_replay_uncertain")
    const final = durableResult ?? (resultItem && terminalStatus(resultItem.status) ? itemResult(callId, call.toolName, call, resultItem) : undefined)
    // Root tool execution has historically routed protocol version 1; retain that version for old item rows.
    const toolVersion = typeof call.toolVersion === "string" && call.toolVersion.trim() ? call.toolVersion : "1"
    pending.push({
      call: { id: callId, name: call.toolName, arguments: call.input ?? {} }, toolVersion, stepId: callItem.stepId,
      callItem: callHandle, ...(resultHandle ? { resultItem: resultHandle } : {}), ...(final ? { durableResult: final } : {}),
    })
    pendingIds.add(callId)
  }
  const outputs = finalByCall
  const observations = [...results.entries()].flatMap(([callId, resultItem]) => {
    if (pendingIds.has(callId)) return []
    const callItem = calls.get(callId)
    if (!callItem) return []
    const call = object(callItem.content), content = object(resultItem.content)
    if (typeof call.toolName !== "string") return []
    const output = Object.prototype.hasOwnProperty.call(content, "output") && content.output !== null
      ? content.output
      : outputs.get(callId)?.result.output ?? content.output ?? null
    return [{ id: `tool-result:${callId}`, content: {
      toolCallId: callId, toolName: call.toolName, input: call.input ?? {}, status: call.status ?? (content.errorCode ? "failed" : "completed"),
      output, errorCode: content.errorCode ?? null,
    } }]
  })
  return { observations, pending }
}
