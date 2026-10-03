import type pg from "pg"
import { computeSubagentNextAttemptAt } from "./retry-policy.js"
import { RUNNABLE_SESSION } from "../session-gate.js"
import { persistGraphTransition, prepareGraphTransition, reconcileGraphDependents, taskGraphEventType, type GraphTransitionPreparation } from "./task-graph-pg-lifecycle.js"
import { TASK_GRAPH_VERIFIER_VERSION, verifyTaskGraphNodeEvidence, type TaskGraphVerificationReport } from "./task-graph-pg-verification.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus } from "./task-graph-command-port.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { dateValue, json, rowToTask, transaction } from "./pg-store-persistence.js"
import type { PgSubagentPool, SubagentTaskRecord } from "./types.js"
type Selector = Readonly<{ sessionId: string; userId?: string; turnId?: string; rootTaskId?: string; targetPath?: string }>
type Candidate = Record<string, unknown> & Readonly<{ id: string; status: string; attemptCount: number; sessionId: string; userId: string }>
export async function prepareTaskGraphFinish(client: pg.PoolClient, input: { taskId: string; sessionId: string; attemptCount: number; status: string; retry: boolean; failureReason?: string; result: unknown }): Promise<{ graph: GraphTransitionPreparation; status: string; failureReason?: string; result: unknown; reconcileDependents?: boolean }> {
  const safeInputResult = stripTaskGraphMetadata(input.result)
  const graphType = taskGraphEventType(input.status, input.retry)
  let graph = graphType ? await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId, type: graphType, attemptCount: input.attemptCount, failureReason: input.failureReason }) : null
  if (!graph || "blocked" in graph) return { graph, status: input.status, failureReason: input.failureReason, result: safeInputResult }
  const node = graph.snapshot.nodes.find(candidate => candidate.taskId === input.taskId)
  if (!node || (node.templateId !== "scout" && node.templateId !== "analyst")) return { graph, status: input.status, failureReason: input.failureReason, result: safeInputResult }
  if (input.status !== "completed") {
    if (input.status === "failed") {
      const report = unverifiedFailureReport(node)
      const failureReason = "task_graph_verification_unverified"
      graph = await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId, type: "task.failed", attemptCount: input.attemptCount, failureReason })
      return { graph, status: input.status, failureReason, result: taskGraphVerificationResult(safeInputResult, report, undefined, null) }
    }
    return { graph, status: input.status, failureReason: input.failureReason, result: safeInputResult }
  }
  const envelope = plainObject(safeInputResult)
  const structuredResult = envelope?.structuredResult
  const evidence = node.verificationDisposition === "typed" && node.verification
    ? await verifyTaskGraphNodeEvidence(client, { scope: { ...graph.scope, taskId: input.taskId, attemptCount: input.attemptCount }, snapshot: graph.snapshot, node, structuredResult })
    : { verified: false, report: unverifiedFailureReport(node) }
  const typedPass = node.verificationDisposition === "typed" && evidence.verified && evidence.report.status === "passed"
  const repairReceipt = typedPass && node.repairOf ? await validateRepairTarget(client, graph, node, input.taskId, evidence.report) : null
  const repairRejected = typedPass && Boolean(node.repairOf) && !repairReceipt
  const report = repairRejected ? { ...evidence.report, status: "unverified" as const, reasonCode: "repair_target_unresolved", evidenceDigest: null } : evidence.report
  const boundResult = "structuredResult" in evidence ? evidence.structuredResult : undefined
  const safeResult = taskGraphVerificationResult(safeInputResult, report, boundResult, repairReceipt)
  if (typedPass && !repairRejected) return { graph, status: input.status, failureReason: input.failureReason, result: safeResult, reconcileDependents: true }
  const failureReason = repairRejected ? "task_graph_repair_target_unresolved" : evidence.report.status === "failed" ? "task_graph_verification_failed" : "task_graph_verification_unverified"
  graph = await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId, type: "task.failed", attemptCount: input.attemptCount, failureReason })
  return { graph, status: "failed", failureReason, result: safeResult }
}
const TASK_GRAPH_REPAIR_RECEIPT_SCHEMA = "agent-harness.v2.task-graph-repair-receipt.v1" as const; const RESERVED_RESULT_KEYS = new Set(["taskGraphVerificationReport", "verificationReport", "taskGraphRepairReceipt"])
function unverifiedFailureReport(node: StoredTaskGraphNode): TaskGraphVerificationReport {
  const reasonCode = node.verificationDisposition === "typed" && node.verification ? "result_invalid" : "contract_invalid"
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode, criteria: node.verification?.criteria.map(item => ({ criterionId: item.id, status: "unverified", reasonCode })) ?? [], evidenceDigest: null, resultDigest: null }
}
function plainObject(value: unknown): Record<string, unknown> | null {
  let parsed = value; if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return null } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null; const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : null
}
function stripTaskGraphMetadata(value: unknown, active = new Set<object>(), depth = 0): unknown {
  if (depth > 32) return null
  if (typeof value === "string" && depth > 0) return value
  if (Array.isArray(value)) {
    if (active.has(value)) return null; active.add(value)
    try { return value.map(item => stripTaskGraphMetadata(item, active, depth + 1)) } finally { active.delete(value) }
  }
  const source = plainObject(value)
  if (!source) return value; if (active.has(source)) return null
  active.add(source)
  try {
    return Object.fromEntries(Object.entries(source).filter(([key]) => !RESERVED_RESULT_KEYS.has(key)).map(([key, child]) => [key, stripTaskGraphMetadata(child, active, depth + 1)]))
  } finally { active.delete(source) }
}
async function validateRepairTarget(client: pg.PoolClient, graph: Exclude<GraphTransitionPreparation, null | Readonly<{ blocked: true }>>, node: (typeof graph.snapshot.nodes)[number], taskId: string, report: TaskGraphVerificationReport): Promise<Record<string, unknown> | null> { const relation = node.repairOf
  if (!relation || relation.graphRootTaskId !== graph.scope.rootTaskId || !/^[a-f0-9]{64}$/.test(report.evidenceDigest ?? "")) return null
  const targetNode = graph.snapshot.nodes.find(candidate => candidate.key === relation.nodeKey)
  if (!targetNode || targetNode.taskId !== relation.taskId || targetNode.verificationDisposition !== "typed" || !targetNode.verification
    || node.taskId !== taskId || !node.verification || !relation.criterionIds.length) return null
  const targetResult = await client.query(`SELECT target."id", target."status", target."result", target."rootTaskId", target."parentTaskId", target."failureReason" FROM "sub_agent_tasks" AS target
    JOIN "agent_sessions" AS session ON session."id" = target."sessionId" JOIN "agent_turns" AS turn ON turn."id" = target."turnId" AND turn."sessionId" = target."sessionId"
    WHERE target."id" = $1 AND target."sessionId" = $2 AND target."turnId" = $3 AND target."rootTaskId" = $4 AND target."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [relation.taskId, graph.scope.sessionId, graph.scope.turnId, graph.scope.rootTaskId, graph.scope.parentTaskId, graph.scope.userId])
  const target = targetResult.rows[0] as Record<string, unknown> | undefined
  const expected = targetNode.verification.criteria.map(criterion => criterion.id)
  const targetReport = parseTaskGraphVerificationReport(plainObject(plainObject(target?.result)?.taskGraphVerificationReport), expected), statuses = new Map<string, string>()
  if (!target || target.id !== relation.taskId || target.rootTaskId !== graph.scope.rootTaskId
    || target.parentTaskId !== graph.scope.parentTaskId || target.status !== "failed"
    || !targetReport || !taskGraphVerificationReportMatchesStatus(targetReport, "failed")
    || target.failureReason !== (targetReport.reasonCode === "repair_target_unresolved" ? "task_graph_repair_target_unresolved" : targetReport.status === "failed" ? "task_graph_verification_failed" : "task_graph_verification_unverified")
    ) return null
  for (const item of targetReport.criteria) statuses.set(item.criterionId, item.status)
  if (!relation.criterionIds.every(id => statuses.get(id) === "failed" || statuses.get(id) === "unverified")) return null
  if (await priorRepairResolves(client, graph, targetNode, relation, taskId)) return null
  return { schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA, graphRootTaskId: graph.scope.rootTaskId,
    targetNodeKey: targetNode.key, targetTaskId: targetNode.taskId, criterionIds: [...relation.criterionIds], repairNodeKey: node.key,
    repairTaskId: taskId, verifierVersion: report.verifierVersion, evidenceDigest: report.evidenceDigest }
}
async function priorRepairResolves(client: pg.PoolClient, graph: Exclude<GraphTransitionPreparation, null | Readonly<{ blocked: true }>>, target: StoredTaskGraphNode, relation: NonNullable<StoredTaskGraphNode["repairOf"]>, taskId: string): Promise<boolean> {
  const nodes = graph.snapshot.nodes.filter(node => node.taskId !== taskId && node.repairOf?.graphRootTaskId === relation.graphRootTaskId && node.repairOf.nodeKey === target.key && node.repairOf.taskId === target.taskId && node.repairOf.criterionIds.some(id => relation.criterionIds.includes(id)))
  if (!nodes.length) return false
  const previous = await client.query(`SELECT prior."id", prior."status", prior."result", prior."failureReason" FROM "sub_agent_tasks" prior JOIN "agent_sessions" session ON session."id" = prior."sessionId" JOIN "agent_turns" turn ON turn."id" = prior."turnId" AND turn."sessionId" = prior."sessionId" WHERE prior."id" = ANY($1::text[]) AND prior."sessionId" = $2 AND prior."turnId" = $3 AND prior."rootTaskId" = $4 AND prior."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`, [nodes.map(node => node.taskId), graph.scope.sessionId, graph.scope.turnId, graph.scope.rootTaskId, graph.scope.parentTaskId, graph.scope.userId])
  return previous.rows.some(raw => {
    const node = nodes.find(candidate => candidate.taskId === raw.id)
    if (raw.status !== "completed" || raw.failureReason !== null || !node?.repairOf || !node.verification) return false
    const result = plainObject(raw.result)
    const ids = node.verification.criteria.map(item => item.id), report = parseTaskGraphVerificationReport(result?.taskGraphVerificationReport, ids)
    return Boolean(parseTaskGraphRepairReceipt(result?.taskGraphRepairReceipt, { repairOf: node.repairOf, repairNodeKey: node.key, repairTaskId: node.taskId, report })?.criterionIds.some(id => relation.criterionIds.includes(id)))
  })
}
function taskGraphVerificationResult(value: unknown, report: unknown, boundResult: unknown, repairReceipt: Record<string, unknown> | null): unknown { const safe = stripTaskGraphMetadata(plainObject(value) ?? { workerResult: value }) as Record<string, unknown>
  if (boundResult !== undefined) safe.structuredResult = boundResult; else delete safe.structuredResult
  return { ...safe, taskGraphVerificationReport: report, ...(repairReceipt ? { taskGraphRepairReceipt: repairReceipt } : {}) }
}
export async function interruptTree(pool: PgSubagentPool, input: { sessionId: string; rootTaskId: string; now: Date }): Promise<number> {
  return interruptMatching(pool, { sessionId: input.sessionId, rootTaskId: input.rootTaskId }, input.now)
}
export async function interruptTurn(pool: PgSubagentPool, input: { userId: string; sessionId: string; turnId: string; now: Date }): Promise<number> {
  return interruptMatching(pool, { userId: input.userId, sessionId: input.sessionId, turnId: input.turnId }, input.now)
}
export async function interruptSubtree(pool: PgSubagentPool, input: { sessionId: string; rootTaskId: string; targetPath: string; now: Date }): Promise<number> {
  return interruptMatching(pool, { sessionId: input.sessionId, rootTaskId: input.rootTaskId, targetPath: input.targetPath }, input.now)
}
async function interruptMatching(pool: PgSubagentPool, selector: Selector, now: Date): Promise<number> {
  return transaction(pool, async client => {
    const session = await client.query(`SELECT "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [selector.sessionId])
    const sessionRow = session.rows[0] as Record<string, unknown> | undefined
    if (!sessionRow || sessionRow.status === "aborted" || sessionRow.status === "archived"
      || (selector.userId && sessionRow.userId !== selector.userId)) return 0
    const userId = String(sessionRow.userId)
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
    const { sql, values } = selectorWhere(selector)
    const selected = await client.query(`SELECT task."id", task."status", task."attemptCount" FROM "sub_agent_tasks" AS task
      JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE ${sql} AND session."userId" = $${values.length + 1}
        AND task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
      ORDER BY task."rootTaskId", task."id"`, [...values, userId])
    let changed = 0
    for (const raw of selected.rows as Candidate[]) {
      const running = raw.status === "running"
      const graph = running ? null : await prepareGraphTransition(client, {
        taskId: raw.id, sessionId: selector.sessionId, type: "task.interrupted", attemptCount: Number(raw.attemptCount),
      })
      if (graph && "blocked" in graph) continue
      const update = running
        ? `UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = COALESCE("interruptRequestedAt", $3), "updatedAt" = $3
            WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running'`
        : `UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = COALESCE("interruptRequestedAt", $3), "status" = 'interrupted',
            "nextAttemptAt" = NULL, "completedAt" = $3, "updatedAt" = $3
            WHERE "id" = $1 AND "sessionId" = $2 AND "status" = $4`
      const params = running ? [raw.id, selector.sessionId, now] : [raw.id, selector.sessionId, now, raw.status]
      const result = await client.query(update, params)
      if (result.rowCount !== 1) continue
      changed++
      if (!running) {
        await removePendingDispatch(client, selector.sessionId, raw.id)
        if (graph) {
          await persistGraphTransition(client, graph, now)
          await reconcileGraphDependents(client, graph.scope, now)
        }
      }
    }
    return changed
  })
}
function selectorWhere(selector: Selector): { sql: string; values: unknown[] } {
  const values: unknown[] = [selector.sessionId]
  const parts = [`task."sessionId" = $1`]
  if (selector.turnId) { values.push(selector.turnId); parts.push(`task."turnId" = $${values.length}`) }
  if (selector.rootTaskId) { values.push(selector.rootTaskId); parts.push(`task."rootTaskId" = $${values.length}`) }
  if (selector.targetPath) {
    values.push(selector.targetPath)
    parts.push(`(task."path" = $${values.length} OR task."path" LIKE $${values.length} || '/%')`)
  }
  return { sql: parts.join(" AND "), values }
}
export async function recoverExpired(pool: PgSubagentPool, input: { now: Date; limit: number }): Promise<SubagentTaskRecord[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new RangeError("Recovery limit must be positive")
  return transaction(pool, async client => {
    const candidates = await client.query(`SELECT task."id", task."sessionId", task."rootTaskId", session."userId"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."status" = 'running' AND (session."status" IN ('aborted', 'archived') OR ${RUNNABLE_SESSION})
        AND (task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= clock_timestamp())
        AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp())
      ORDER BY task."sessionId", task."rootTaskId", task."id" LIMIT $1`, [input.limit])
    const recovered: SubagentTaskRecord[] = []
    for (const candidate of candidates.rows as Candidate[]) {
      const outcome = await recoverOne(client, candidate)
      if (outcome) recovered.push(outcome)
    }
    return recovered
  })
}
async function recoverOne(client: pg.PoolClient, candidate: Candidate): Promise<SubagentTaskRecord | null> {
  const session = await client.query(`SELECT "id", "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [candidate.sessionId])
  const sessionRow = session.rows[0] as Record<string, unknown> | undefined
  if (!sessionRow || sessionRow.userId !== candidate.userId) return null
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [candidate.userId])
  const sql = `SELECT task.*, session."userId" AS "userId", session."status" AS "sessionStatus"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND session."userId" = $3 AND task."status" = 'running'
      AND (session."status" IN ('aborted', 'archived') OR task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= clock_timestamp())
      AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp())`
  const preview = await client.query(sql, [candidate.id, candidate.sessionId, candidate.userId])
  const old = preview.rows[0] as Record<string, unknown> | undefined
  if (!old) return null
  const attemptCount = Number(old.attemptCount)
  const closedSession = old.sessionStatus === "aborted" || old.sessionStatus === "archived"
  const interrupted = closedSession || old.interruptRequestedAt !== null
  const terminal = interrupted || attemptCount >= Number(old.maxAttempts)
  const status = terminal ? interrupted ? "interrupted" : "failed" : "queued"
  let failureReason = status === "failed" ? "Worker lease expired after maximum attempts." : old.failureReason ?? null
  const eventType = status === "interrupted" ? "task.interrupted" : status === "failed" ? "task.failed" : "task.retrying"
  let graph = await prepareGraphTransition(client, {
    taskId: candidate.id, sessionId: candidate.sessionId, type: eventType,
    attemptCount, ...(eventType === "task.failed" ? { failureReason: String(failureReason) } : {}),
  })
  if (graph && "blocked" in graph) return null
  const locked = await client.query(`${sql} FOR UPDATE OF task`, [candidate.id, candidate.sessionId, candidate.userId])
  const row = locked.rows[0] as Record<string, unknown> | undefined
  if (!row || Number(row.attemptCount) !== attemptCount) return null
  const leaseClock = await client.query<{ checkedAt: Date }>(`SELECT clock_timestamp() AS "checkedAt"`)
  const checkedAt = leaseClock.rows[0]?.checkedAt
  if (!checkedAt) return null
  const lockedSessionClosed = row.sessionStatus === "aborted" || row.sessionStatus === "archived"
  const lockedExpiry = dateValue(row.leaseExpiresAt)
  const lockedRetryAt = dateValue(row.nextAttemptAt)
  if ((!lockedSessionClosed && lockedExpiry && lockedExpiry > checkedAt) || (lockedRetryAt && lockedRetryAt > checkedAt)) return null
  let persistedResult: unknown, resultUpdated = false
  if (status === "failed" && graph && !("blocked" in graph) && graph.snapshot.nodes.some(node => node.taskId === candidate.id && node.verificationDisposition === "typed" && node.verification)) {
    const finish = await prepareTaskGraphFinish(client, { taskId: candidate.id, sessionId: candidate.sessionId, attemptCount, status, retry: false, failureReason: String(failureReason), result: row.result ?? null }); if (finish.graph && "blocked" in finish.graph) return null
    graph = finish.graph; failureReason = finish.failureReason ?? failureReason; persistedResult = finish.result; resultUpdated = true
  }
  const nextAttemptAt = status === "queued" ? computeSubagentNextAttemptAt(attemptCount, checkedAt) : null
  const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
    "nextAttemptAt" = $4, "failureReason" = $5, "completedAt" = CASE WHEN $6 THEN $7::timestamp(3) ELSE NULL::timestamp(3) END, "updatedAt" = $7,
    "result" = CASE WHEN $10 THEN $11::jsonb ELSE "result" END
    WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running'
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
        WHERE session."id" = "sub_agent_tasks"."sessionId" AND session."userId" = $8 AND session."status" = $9::text)
      AND ($9::text IN ('aborted', 'archived') OR "leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
      AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp())`,
  [candidate.id, candidate.sessionId, status, nextAttemptAt, failureReason, terminal, checkedAt, candidate.userId, row.sessionStatus, resultUpdated, resultUpdated ? json(persistedResult, null, "subagent_task_result") : null])
  if (updated.rowCount !== 1) return null
  if (graph) { await persistGraphTransition(client, graph, checkedAt, { stream: !closedSession, allowClosedSession: closedSession }); if (terminal) await reconcileGraphDependents(client, graph.scope, checkedAt, { stream: !closedSession, allowClosedSession: closedSession }) }
  if (status === "queued") await resetDispatch(client, candidate.sessionId, candidate.id)
  else await removePendingDispatch(client, candidate.sessionId, candidate.id)
  return { ...rowToTask(row), status, nextAttemptAt, leaseOwner: null, leaseExpiresAt: null, failureReason: failureReason ? String(failureReason) : null, ...(resultUpdated ? { result: persistedResult } : {}) }
}
async function removePendingDispatch(client: pg.PoolClient, sessionId: string, taskId: string): Promise<void> {
  await client.query(`DELETE FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1
    AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`, [sessionId, `subagent-dispatch:${taskId}`])
}
async function resetDispatch(client: pg.PoolClient, sessionId: string, taskId: string): Promise<void> {
  await client.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
    WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [sessionId, `subagent-dispatch:${taskId}`])
}
