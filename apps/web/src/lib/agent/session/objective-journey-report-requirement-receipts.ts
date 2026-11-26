import { Buffer } from "node:buffer"
import { Prisma } from "@prisma/client"
import { canonicalTaskGraphReadObservations } from "@jobcopilot/shared/task-graph-read-observations"
import { validateTaskGraphReplaySources, validateTaskGraphToolEvents, validateTaskGraphVerificationItems,
  restoreToolCallState, type TaskGraphReplayReceipt, type TaskGraphToolVerificationScope } from "@jobcopilot/shared/task-graph-tool-receipt-verification"
import type { ObjectiveJourneySource } from "./objective-journey-report-source"

type Tx = Pick<Prisma.TransactionClient, "$queryRaw" | "subAgentTask" | "job">
type ReceiptTx = Pick<Prisma.TransactionClient, "$queryRaw">
type Row = Record<string, unknown>
const MAX_ITEMS = 1024
const MAX_EVENTS = MAX_ITEMS * 3
const MAX_OBSERVATIONS = 256
const MAX_TOTAL_BYTES = 2 * 1024 * 1024

export type ObjectiveJourneyRequirementRead = Readonly<{
  scope: TaskGraphToolVerificationScope
  taskResult: unknown
  currentJob: Row
  items: readonly Row[]
  outcomes: ReadonlyMap<string, "completed" | "failed">
  replayReceipts: readonly TaskGraphReplayReceipt[]
  evidenceObservations: readonly Row[]
}>

export type ObjectiveTaskToolReceiptSet = Readonly<{
  items: readonly Row[]
  outcomes: ReadonlyMap<string, "completed" | "failed">
  replayReceipts: readonly TaskGraphReplayReceipt[]
  evidenceObservations: readonly Row[]
}>

/** Reads current owned Analyst, Job and exact Worker-compatible tool receipts in the report transaction. */
export async function readObjectiveJourneyRequirementReceipts(tx: Tx, source: ObjectiveJourneySource,
  slot: ObjectiveJourneySource["slots"][number]): Promise<ObjectiveJourneyRequirementRead | null> {
  const analyst = slot.requirementAnalyst, jobId = slot.jobId
  if (!slot.sourceReady || !analyst || !jobId) return null
  const scope: TaskGraphToolVerificationScope = { userId: source.userId, sessionId: source.sessionId, turnId: source.sourceTurnId,
    rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId, taskId: analyst.taskId, attemptCount: analyst.attemptCount }
  const [tasks, jobs] = await Promise.all([
    tx.subAgentTask.findMany({ where: { id: analyst.taskId, sessionId: scope.sessionId, session: { is: { userId: scope.userId } }, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, role: "analyst", taskType: "job_analysis", status: "completed",
      attemptCount: scope.attemptCount, failureReason: null, leaseOwner: null, leaseExpiresAt: null }, take: 2,
      select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, role: true, taskType: true,
        status: true, attemptCount: true, failureReason: true, leaseOwner: true, leaseExpiresAt: true, result: true,
        expectedOutputSchema: true, allowedActions: true } }),
    tx.job.findMany({ where: { id: jobId, userId: scope.userId }, take: 2,
      select: { id: true, userId: true, company: true, description: true, keywords: true, location: true, role: true,
        salary: true, score: true, source: true, status: true, url: true } }),
  ])
  const task = tasks[0] as Row | undefined, currentJob = jobs[0] as Row | undefined
  if (tasks.length !== 1 || !task || task.id !== analyst.taskId || task.sessionId !== scope.sessionId || task.turnId !== scope.turnId
    || task.rootTaskId !== scope.rootTaskId || task.parentTaskId !== scope.parentTaskId || task.role !== "analyst"
    || task.taskType !== "job_analysis" || task.status !== "completed" || task.failureReason !== null
    || task.attemptCount !== scope.attemptCount || task.leaseOwner !== null || task.leaseExpiresAt !== null
    || !validAnalystTaskEnvelope(task)
    || jobs.length !== 1 || !currentJob || currentJob.id !== jobId || currentJob.userId !== scope.userId) return null

  const receiptSet = await readObjectiveTaskToolReceiptSet(tx, scope)
  return receiptSet ? { scope, taskResult: task.result, currentJob, ...receiptSet } : null
}

/** Reads the exact current-attempt Worker receipt set for one owner-scoped task. */
export async function readObjectiveTaskToolReceiptSet(tx: ReceiptTx,
  scope: TaskGraphToolVerificationScope): Promise<ObjectiveTaskToolReceiptSet | null> {
  const items = await readCurrentItems(tx, scope)
  if (!items) return null
  let checkedItems: Row[]
  try { checkedItems = validateTaskGraphVerificationItems(items, scope) } catch { return null }
  const callIds = checkedItems.filter(item => item.type === "tool_call").map(item => String(item.id))
  const events = await readCurrentEvents(tx, scope, callIds)
  if (!events) return null
  let outcomes: ReadonlyMap<string, "completed" | "failed">, evidenceObservations: readonly Row[]
  let replayProofs: Parameters<typeof validateTaskGraphReplaySources>[0]
  try {
    const validation = validateTaskGraphToolEvents(events, checkedItems, scope)
    const restored = restoreToolCallState(checkedItems, events)
    const restoredJson = JSON.stringify(restored.observations)
    if (restored.pending.length !== 0 || restored.observations.length > MAX_OBSERVATIONS || restoredJson === undefined
      || Buffer.byteLength(restoredJson, "utf8") > MAX_TOTAL_BYTES) return null
    evidenceObservations = canonicalTaskGraphReadObservations(checkedItems, validation.outcomes)
    outcomes = validation.outcomes; replayProofs = validation.replays
  } catch { return null }
  const replayReceipts = await readReplayReceipts(tx, scope, checkedItems, replayProofs)
  return replayReceipts ? { items: checkedItems, outcomes, replayReceipts, evidenceObservations } : null
}

async function readCurrentItems(tx: ReceiptTx, scope: TaskGraphToolVerificationScope): Promise<Row[] | null> {
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT item."id", item."sessionId", item."turnId", item."taskId", item."stepId", item."type", item."status", item."revision",
      item."content", step."id" AS "joinedStepId", step."status" AS "stepStatus", step."attempt" AS "attempt", step."ordinal" AS "ordinal",
      task."rootTaskId" AS "rootTaskId", turn."rootTaskId" AS "turnRootTaskId"
    FROM "agent_items" AS item
    JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId"
      AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
    JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId"
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."taskId" = ${scope.taskId} AND item."sessionId" = ${scope.sessionId} AND item."turnId" = ${scope.turnId}
      AND task."rootTaskId" = ${scope.rootTaskId} AND turn."rootTaskId" = ${scope.rootTaskId}
      AND task."parentTaskId" = ${scope.parentTaskId} AND session."userId" = ${scope.userId} AND turn."userId" = ${scope.userId}
      AND step."attempt" = ${scope.attemptCount} AND item."type" IN ('tool_call', 'tool_result')
    ORDER BY step."attempt" ASC, step."ordinal" ASC, item."createdAt" ASC, item."id" ASC LIMIT ${MAX_ITEMS + 1}`)
  if (rows.length > MAX_ITEMS) return null
  return rows
}

async function readCurrentEvents(tx: ReceiptTx, scope: TaskGraphToolVerificationScope, callIds: readonly string[]): Promise<Row[] | null> {
  if (callIds.length === 0) return []
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT event."id", event."itemId", event."taskId", event."correlationId", event."type", event."payload", event."sequence"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId}
      AND session."userId" = ${scope.userId} AND turn."userId" = ${scope.userId}
      AND event."itemId" IN (${Prisma.join(callIds)})
      AND event."type" IN ('tool_call.started', 'tool_call.completed', 'tool_call.failed')
    ORDER BY event."sequence" ASC LIMIT ${MAX_EVENTS + 1}`)
  if (rows.length > MAX_EVENTS) return null
  return rows
}

async function readReplayReceipts(tx: ReceiptTx, scope: TaskGraphToolVerificationScope, items: readonly Row[],
  proofs: Parameters<typeof validateTaskGraphReplaySources>[0]): Promise<readonly TaskGraphReplayReceipt[] | null> {
  if (proofs.length === 0) { try { return validateTaskGraphReplaySources(proofs, [], [], items, scope) } catch { return null } }
  const resultIds = proofs.map(proof => proof.source.resultItemId)
  const sources = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT result."sessionId" AS "sourceSessionId", result."turnId" AS "sourceTurnId", result."taskId" AS "sourceTaskId",
      task."rootTaskId" AS "sourceRootTaskId", task."parentTaskId" AS "sourceParentTaskId", turn."rootTaskId" AS "sourceTurnRootTaskId",
      session."userId" AS "sourceUserId", call."id" AS "sourceCallItemId", call."stepId" AS "sourceCallStepId",
      call."type" AS "sourceCallType", call."status" AS "sourceCallStatus", call."revision" AS "sourceCallRevision",
      call."content" AS "sourceCallContent", callStep."attempt" AS "sourceCallAttempt", callStep."ordinal" AS "sourceCallOrdinal",
      result."id" AS "sourceResultItemId", result."stepId" AS "sourceResultStepId", result."type" AS "sourceResultType",
      result."status" AS "sourceResultStatus", result."revision" AS "sourceResultRevision", result."content" AS "sourceResultContent",
      resultStep."attempt" AS "sourceResultAttempt", resultStep."ordinal" AS "sourceResultOrdinal"
    FROM "agent_items" AS result
    JOIN "agent_steps" AS resultStep ON resultStep."id" = result."stepId" AND resultStep."sessionId" = result."sessionId"
      AND resultStep."turnId" = result."turnId" AND resultStep."taskId" = result."taskId"
    JOIN "agent_items" AS call ON call."stepId" = result."stepId" AND call."sessionId" = result."sessionId"
      AND call."turnId" = result."turnId" AND call."taskId" = result."taskId" AND call."type" = 'tool_call'
      AND call."content"->>'toolCallId' = result."content"->>'toolCallId'
    JOIN "agent_steps" AS callStep ON callStep."id" = call."stepId" AND callStep."sessionId" = call."sessionId"
      AND callStep."turnId" = call."turnId" AND callStep."taskId" = call."taskId"
    JOIN "sub_agent_tasks" AS task ON task."id" = result."taskId" AND task."sessionId" = result."sessionId" AND task."turnId" = result."turnId"
    JOIN "agent_sessions" AS session ON session."id" = result."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = result."turnId" AND turn."sessionId" = result."sessionId"
    WHERE result."id" IN (${Prisma.join(resultIds)}) AND result."type" = 'tool_result' AND result."taskId" = ${scope.taskId}
      AND result."sessionId" = ${scope.sessionId} AND result."turnId" = ${scope.turnId} AND task."rootTaskId" = ${scope.rootTaskId}
      AND turn."rootTaskId" = ${scope.rootTaskId} AND task."parentTaskId" = ${scope.parentTaskId}
      AND session."userId" = ${scope.userId} AND turn."userId" = ${scope.userId}
      AND resultStep."attempt" >= 1 AND resultStep."attempt" < ${scope.attemptCount}
    ORDER BY result."id" LIMIT ${MAX_ITEMS + 1}`)
  if (sources.length > MAX_ITEMS) return null
  const sourceCallIds = sources.map(row => String(row.sourceCallItemId))
  const sourceEvents = sourceCallIds.length === 0 ? [] : await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT event."id", session."userId" AS "userId", event."sessionId", event."turnId", event."itemId", event."taskId",
      event."correlationId", event."type", event."payload", event."sequence"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId} AND session."userId" = ${scope.userId}
      AND turn."userId" = ${scope.userId} AND event."itemId" IN (${Prisma.join(sourceCallIds)}) AND event."taskId" = ${scope.taskId}
      AND event."type" IN ('tool_call.started', 'tool_call.completed', 'tool_call.failed')
    ORDER BY event."sequence" ASC LIMIT ${MAX_EVENTS + 1}`)
  if (sourceEvents.length > MAX_EVENTS) return null
  try { return validateTaskGraphReplaySources(proofs, sources, sourceEvents, items, scope) } catch { return null }
}

function validAnalystTaskEnvelope(task: Row): boolean {
  let schema = task.expectedOutputSchema
  if (typeof schema === "string") { try { schema = JSON.parse(schema) as unknown } catch { return false } }
  const row = plainRecord(schema), actions = task.allowedActions
  const exactActions = (expected: readonly string[]) => Array.isArray(actions) && actions.length === expected.length
    && Reflect.ownKeys(actions).length === actions.length + 1 && expected.every((value, index) => actions[index] === value)
  return !!row && Object.keys(row).sort().join(",") === "role,schemaVersion" && row.schemaVersion === "agent-harness.v2.subagent.result"
    && row.role === "analyst" && (exactActions(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"])
      || exactActions(["jobs.get", "persona.retrieve", "resume.get_base"]))
}
function plainRecord(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined }
  catch { return undefined }
}
