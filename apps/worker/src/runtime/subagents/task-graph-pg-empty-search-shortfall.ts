import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { Value } from "@sinclair/typebox/value"
import { resolveRootTaskVerificationRequirements } from "../context/root-task-objective.js"
import { JobSearchInputSchema } from "../tools/read-tools.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import type { TaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"

type Row = Record<string, unknown>
const MAX_CALLS = 32

/** Binds empty search evidence to an owner-scoped native ObjectiveStart and this exact Scout. */
export function objectiveEmptySearchCriterionIds(input: Readonly<{
  scope: TaskGraphVerificationScope; node: StoredTaskGraphNode; turnSource: unknown
  turnExecutionMode: unknown; turnInput: unknown; receipts: TaskGraphVerificationReceipts
}>): readonly string[] | undefined {
  if (input.turnSource !== "user" || input.turnExecutionMode !== "canonical_task_graph"
    || input.node.taskId !== input.scope.taskId || input.node.templateId !== "scout"
    || input.node.verificationDisposition !== "typed" || input.node.verification?.role !== "scout") return undefined
  const turn = row(input.turnInput), intent = turn && exactRecord(turn.intent, ["kind", "version"])
  if (!turn || Object.hasOwn(turn, "input") || !intent
    || intent.kind !== OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind || intent.version !== OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version) return undefined
  const objective = resolveRootTaskVerificationRequirements(turn)
  if (objective.status !== "valid") return undefined
  const requirements = new Map<string, number>()
  for (const requirement of objective.requirements) if (requirement.kind === "candidate_count_gte") requirements.set(requirement.id, requirement.minimum)
  const ids = input.node.verification.criteria.filter(item => item.check.kind === "candidate_count_gte"
    && requirements.has(item.id) && item.check.minimum >= requirements.get(item.id)!).map(item => item.id)
  return ids.length && emptySearchReceipts(input.receipts) ? ids : undefined
}

function emptySearchReceipts(receipts: TaskGraphVerificationReceipts): boolean {
  const calls = receipts.items.filter(item => item.type === "tool_call")
  if (!calls.length || calls.length > MAX_CALLS || receipts.items.length !== calls.length * 2
    || receipts.outcomes.size !== calls.length || receipts.replayReceipts.length) return false
  const results = new Map<string, Row>(), callIds = new Set<string>()
  for (const item of receipts.items.filter(item => item.type === "tool_result")) {
    const content = exactRecord(item.content, ["errorCode", "output", "toolCallId"])
    if (!content || typeof content.toolCallId !== "string" || results.has(content.toolCallId)) return false
    results.set(content.toolCallId, content)
  }
  if (results.size !== calls.length) return false
  for (const item of calls) {
    const call = exactRecord(item.content, ["errorCode", "input", "status", "toolCallId", "toolName", "toolVersion"])
    const id = call && typeof call.toolCallId === "string" ? call.toolCallId : undefined
    const result = id ? results.get(id) : undefined
    const output = result && exactRecord(result.output, ["hasMore", "jobs", "page"])
    const searchInput = call && row(call.input)
    if (!call || !id || callIds.has(id) || !result || !output || !searchInput
      || receipts.outcomes.get(id) !== "completed" || call.toolName !== "jobs.search" || call.toolVersion !== "1"
      || call.status !== "completed" || call.errorCode !== null || !Value.Check(JobSearchInputSchema, searchInput)
      || searchInput.page !== undefined && searchInput.page !== 1 || result.toolCallId !== id || result.errorCode !== null
      || output.page !== 1 || output.hasMore !== false || !emptyArray(output.jobs)) return false
    callIds.add(id)
  }
  return true
}

function exactRecord(value: unknown, keys: readonly string[]): Row | undefined {
  const parsed = row(value)
  if (!parsed || Reflect.ownKeys(parsed).length !== keys.length || Reflect.ownKeys(parsed).some(key => typeof key !== "string" || !keys.includes(key))) return undefined
  return keys.every(key => Object.hasOwn(parsed, key)) ? parsed : undefined
}
function row(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null ? value as Row : undefined } catch { return undefined }
}
function emptyArray(value: unknown): boolean {
  try { return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length === 0 && Reflect.ownKeys(value).length === 1 } catch { return false }
}
