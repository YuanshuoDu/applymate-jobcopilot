import type pg from "pg"
import { verifiedChildDiscoveryReadPositions } from "./child-discovery-history.js"
import { isOrdinaryScout } from "./child-executor-admission.js"
import { parseDurableDiscoveryReference } from "./child-durable-discovery.js"
import { hasNoCurrentAttemptTaskGraphToolReceipts } from "./task-graph-empty-analyst-proof.js"
import { loadTaskGraphVerificationReceipts, type TaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type ScoutTask = Readonly<{ role: unknown; taskType: unknown; context: unknown; allowedActions: unknown }>
type Pair = Readonly<{ callId: string; toolName: string; status: string; input: unknown; output: unknown }>

/** Reuses only one complete prior discovery group after an empty ordinary Scout retry. */
export async function loadVerifiedPriorScoutDiscoveryReceipts(
  client: Queryable, scope: TaskGraphVerificationScope, node: StoredTaskGraphNode, task: ScoutTask,
): Promise<TaskGraphVerificationReceipts | undefined> {
  if (!ordinaryRegisteredScout(node, task) || scope.attemptCount <= 1
    || !await hasNoCurrentAttemptTaskGraphToolReceipts(client, scope)) return undefined
  const candidate = await client.query(`SELECT step."attempt" AS "attempt", COUNT(item."id")::int AS "itemCount"
    FROM "agent_steps" AS step
    JOIN "sub_agent_tasks" AS task ON task."id" = step."taskId" AND task."sessionId" = step."sessionId" AND task."turnId" = step."turnId"
    JOIN "agent_sessions" AS session ON session."id" = step."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
    JOIN "agent_items" AS item ON item."stepId" = step."id" AND item."type" IN ('tool_call', 'tool_result')
    WHERE step."taskId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND step."attempt" < $7
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND turn."rootTaskId" = $4
      AND session."userId" = $6 AND turn."userId" = $6
    GROUP BY step."attempt" ORDER BY step."attempt" DESC LIMIT 1`,
  [scope.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId, scope.attemptCount])
  const row = record(candidate.rows[0]), attempt = Number(row?.attempt), candidateItemCount = Number(row?.itemCount)
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt >= scope.attemptCount
    || !Number.isSafeInteger(candidateItemCount) || candidateItemCount < 2) return undefined
  const receipts = await loadTaskGraphVerificationReceipts(client, { ...scope, attemptCount: attempt })
  if (receipts.items.length !== candidateItemCount) throw new Error("task_graph_verification_item_invalid")
  return selectCompleteDiscoveryGroup(receipts)
}

function ordinaryRegisteredScout(node: StoredTaskGraphNode, task: ScoutTask): boolean {
  const actions = Array.isArray(task.allowedActions) ? task.allowedActions : []
  return node.templateId === "scout" && node.verificationDisposition === "typed" && node.verification?.role === "scout"
    && node.repairOf === undefined
    && typeof task.role === "string" && typeof task.taskType === "string"
    && isOrdinaryScout({ role: task.role, taskType: task.taskType, context: task.context }, "scout", undefined, undefined)
    && actions.includes("jobs.discover") && actions.includes("tool_results.read")
}

function selectCompleteDiscoveryGroup(receipts: TaskGraphVerificationReceipts): TaskGraphVerificationReceipts | undefined {
  const pairs = validatedPairs(receipts)
  const discoveries = pairs.filter(pair => pair.toolName === "jobs.discover")
  if (discoveries.length !== 1 || discoveries[0]?.status !== "completed") return undefined
  const discovery = discoveries[0]!
  const reference = parseDurableDiscoveryReference(discovery.output)
  if (!reference) return undefined
  const verifiedReads = verifiedChildDiscoveryReadPositions(pairs.map(({ toolName, status, input, output }) => ({ toolName, status, input, output })))
  const reads = pairs.flatMap((pair, index) => {
    if (pair.toolName !== "tool_results.read") return []
    const inputRef = record(pair.input)?.referenceId, outputRef = record(pair.output)?.ref
    return inputRef === reference.ref || outputRef === reference.ref ? [{ pair, index, inputRef, outputRef }] : []
  })
  const completedReads = reads.filter(read => read.pair.status === "completed")
  if (completedReads.length === 0 || completedReads.some(read => read.inputRef !== reference.ref
    || read.outputRef !== reference.ref || !verifiedReads.has(read.index))) return undefined
  const selectedCallIds = new Set([discovery.callId, ...reads.map(read => read.pair.callId)])
  const selectedItems = receipts.items.filter(item => selectedCallIds.has(String(record(item.content)?.toolCallId)))
  if (selectedItems.length !== selectedCallIds.size * 2) return undefined
  const outcomes = new Map([...selectedCallIds].flatMap(callId => {
    const outcome = receipts.outcomes.get(callId)
    return outcome ? [[callId, outcome] as const] : []
  }))
  if (outcomes.size !== selectedCallIds.size) return undefined
  const replayReceipts = receipts.replayReceipts.filter(receipt => selectedCallIds.has(receipt.currentCallId))
  if (replayReceipts.length > 0) return undefined
  const evidenceObservations = receipts.evidenceObservations.filter(observation =>
    typeof observation.content.toolCallId === "string" && selectedCallIds.has(observation.content.toolCallId))
  return { items: selectedItems, outcomes, replayReceipts, evidenceObservations }
}

function validatedPairs(receipts: TaskGraphVerificationReceipts): Pair[] {
  const results = new Map<string, Row>()
  for (const item of receipts.items) {
    if (item.type !== "tool_result") continue
    const content = record(item.content), callId = content?.toolCallId
    if (!content || typeof callId !== "string" || results.has(callId)) throw new Error("task_graph_verification_item_invalid")
    results.set(callId, content)
  }
  return receipts.items.flatMap(item => {
    if (item.type !== "tool_call") return []
    const content = record(item.content), callId = content?.toolCallId, result = typeof callId === "string" ? results.get(callId) : undefined
    const status = typeof callId === "string" ? receipts.outcomes.get(callId) : undefined
    if (typeof callId !== "string" || !content || !result || !status) throw new Error("task_graph_verification_item_invalid")
    return [{ callId, toolName: String(content.toolName), status, input: content.input, output: result.output }]
  })
}

function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined }
}
