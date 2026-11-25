export { taskGraphEvidenceDigest } from "@jobcopilot/shared/task-graph-verification-digest"
export { canonicalTaskGraphReadObservations } from "@jobcopilot/shared/task-graph-read-observations"

export type TaskGraphVerificationScope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string; taskId: string; attemptCount: number }>
type Row = Record<string, unknown>

export function validateTaskGraphVerificationItems(values: readonly unknown[], scope: TaskGraphVerificationScope): Row[] {
  const parsed = values.map(record)
  if (parsed.some(item => !item)) throw new Error("task_graph_verification_item_invalid")
  const items = parsed as Row[], calls = new Map<string, Row>(), results = new Map<string, Row>(), ids = new Set<string>()
  for (const item of items) {
    if (!text(item.id) || ids.has(item.id) || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || item.taskId !== scope.taskId
      || item.rootTaskId !== scope.rootTaskId || item.turnRootTaskId !== scope.rootTaskId || item.joinedStepId !== item.stepId || !text(item.stepId)
      || Number(item.attempt) !== scope.attemptCount || !Number.isSafeInteger(Number(item.ordinal)) || Number(item.ordinal) < 0
      || !Number.isSafeInteger(Number(item.revision)) || Number(item.revision) < 0 || item.status !== "completed"
      || !["queued", "streaming", "completed", "failed", "interrupted", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"].includes(String(item.stepStatus))) throw new Error("task_graph_verification_item_invalid")
    ids.add(item.id)
    const content = record(item.content), callId = content && text(content.toolCallId) ? content.toolCallId : undefined
    const target = item.type === "tool_call" ? calls : item.type === "tool_result" ? results : undefined
    if (!content || !callId) throw new Error("task_graph_verification_item_invalid")
    if (!target || target.has(callId)) throw new Error("task_graph_verification_item_duplicate")
    target.set(callId, { ...item, content })
  }
  if (calls.size === 0 || calls.size !== results.size) throw new Error("task_graph_verification_pair_invalid")
  for (const [callId, call] of calls) {
    const result = results.get(callId), callContent = call.content as Row, resultContent = result?.content as Row | undefined
    if (!result || result.stepId !== call.stepId || Number(result.attempt) !== Number(call.attempt) || Number(result.ordinal) !== Number(call.ordinal)
      || !text(callContent.toolName) || !text(callContent.toolVersion) || !Object.hasOwn(callContent, "input") || !resultContent
      || !Object.hasOwn(resultContent, "output") || result.status !== "completed"
      || (callContent.status !== "completed" && callContent.status !== "failed") || callContent.errorCode !== resultContent.errorCode
      || (callContent.status === "completed" ? callContent.errorCode !== null : !text(callContent.errorCode))) throw new Error("task_graph_verification_pair_invalid")
  }
  return items
}

function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : undefined }
  catch { return undefined }
}

function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
