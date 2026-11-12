import type pg from "pg"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import { prepareGraphTransition, type GraphTransitionPreparation } from "./task-graph-pg-lifecycle.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { isScheduledTaskGraphSpecializedEnvelope } from "./task-graph-pg-specialized-envelope.js"
import { SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_ROLE, SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID } from "./scheduled-post-gate-contract.js"

type FinishInput = Readonly<{
  taskId: string; sessionId: string; attemptCount: number; taskRole?: string; taskType?: string; status: string
}>
type FinishResult = Readonly<{ graph: GraphTransitionPreparation; status: string; failureReason?: string; result: unknown; reconcileDependents?: boolean }>
const POST_GATE_SANITIZED_ENVELOPE_KEYS = new Set([
  "finalItemId", "finalText", "status", "stepCount", "toolCallCount", "structuredResult",
])
const VERIFICATION_REPORT_KEY = "taskGraphVerificationReport"

/** Specialized terminal envelope gate for the post-Gate Execute/Audit suffix. */
export async function prepareScheduledPostGateFinish(client: pg.PoolClient, graph: GraphTransitionPreparation, node: StoredTaskGraphNode | undefined,
  input: FinishInput, safeResult: unknown, finalize: (value: unknown, status: string) => unknown): Promise<FinishResult | null> {
  const kind = node?.templateId === SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID ? "execute"
    : node?.templateId === SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID ? "audit" : null
  const candidate = kind !== null || input.taskType === SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE
    || input.taskType === SCHEDULED_POST_GATE_AUDIT_TASK_TYPE
  if (!candidate || input.status !== "completed") return null
  if (!graph || "blocked" in graph) return reject(client, input, safeResult, finalize,
    kind === "execute" || input.taskType === SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE
      ? "scheduled_post_gate_execute_result_invalid" : "scheduled_post_gate_audit_result_invalid")
  const validKind = kind === "execute" ? input.taskRole === SCHEDULED_POST_GATE_EXECUTE_ROLE && input.taskType === SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE
    : kind === "audit" && input.taskRole === SCHEDULED_POST_GATE_AUDIT_ROLE && input.taskType === SCHEDULED_POST_GATE_AUDIT_TASK_TYPE
  if (!validKind || !node || node.taskId !== input.taskId || node.verificationDisposition !== "specialized") {
    return reject(client, input, safeResult, finalize, kind === "execute" || input.taskType === SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE
      ? "scheduled_post_gate_execute_result_invalid" : "scheduled_post_gate_audit_result_invalid")
  }
  const loaded = await loadTaskGraph(client, graph.scope, true), currentNode = loaded.snapshot?.nodes.find(value => value.taskId === input.taskId)
  const task = loaded.tasks.get(input.taskId)
  if (!loaded.snapshot || !currentNode || !task || task.status !== "running" || task.attemptCount !== input.attemptCount) {
    return reject(client, input, safeResult, finalize, kind === "execute"
      ? "scheduled_post_gate_execute_result_invalid" : "scheduled_post_gate_audit_result_invalid")
  }
  const matchesKind = kind === "execute" && currentNode.templateId === SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID
    || kind === "audit" && currentNode.templateId === SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID
  const canonicalResult = matchesKind ? canonicalizePostGateEnvelope(safeResult) : safeResult
  const completionTask = { ...task, status: "completed" as const, failureReason: null, result: canonicalResult }
  const completionTasks = new Map(loaded.tasks); completionTasks.set(input.taskId, completionTask)
  if (isScheduledTaskGraphSpecializedEnvelope({ snapshot: loaded.snapshot, tasks: completionTasks, node: currentNode, task: completionTask }) !== kind) {
    return reject(client, input, safeResult, finalize, kind === "execute"
      ? "scheduled_post_gate_execute_result_invalid" : "scheduled_post_gate_audit_result_invalid")
  }
  return { graph, status: input.status, result: finalize(canonicalResult, input.status), reconcileDependents: true }
}

function canonicalizePostGateEnvelope(value: unknown): unknown {
  const row = plainRecord(value)
  if (!row || Object.hasOwn(row, VERIFICATION_REPORT_KEY)) return value
  const keys = Reflect.ownKeys(row)
  if (keys.length !== POST_GATE_SANITIZED_ENVELOPE_KEYS.size || keys.some(key => typeof key !== "string"
    || !POST_GATE_SANITIZED_ENVELOPE_KEYS.has(key))) return value
  if (keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(row, key)
    return !descriptor?.enumerable || !("value" in descriptor)
  })) return value
  return { ...row, [VERIFICATION_REPORT_KEY]: null }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
  } catch { return null }
}

async function reject(client: pg.PoolClient, input: FinishInput, safeResult: unknown,
  finalize: (value: unknown, status: string) => unknown, failureReason: string): Promise<FinishResult> {
  const failedGraph = await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId,
    type: "task.failed", attemptCount: input.attemptCount, failureReason })
  return { graph: failedGraph, status: "failed", failureReason, result: finalize(safeResult, "failed") }
}
