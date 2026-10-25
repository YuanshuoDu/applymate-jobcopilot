import { createHash } from "node:crypto"
import type pg from "pg"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import type { ScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { parseScheduledAuditReport } from "./scheduled-audit-contract.js"
import type { ScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type ScheduledPrepareCheckpointStage = "prepare" | "gate" | "audit_completed_report"
export type ScheduledPrepareCheckpoint = Readonly<{ checkpointDigest: string; eligibleJobIds: string[] }>

/** Rechecks Analyze state at its original stage, Gate stage, or the exact completed Audit report checkpoint. */
export async function readScheduledPrepareCheckpoint(client: Queryable, receipt: ScheduledTaskGraphContinuationReceipt,
  automation: ScheduledAutomationSnapshot, handoffKey: string, checkpointStage: ScheduledPrepareCheckpointStage): Promise<ScheduledPrepareCheckpoint | null> {
  if (checkpointStage !== "prepare" && checkpointStage !== "gate" && checkpointStage !== "audit_completed_report") return null
  const owner = receipt.owner
  const rows = await client.query(`SELECT "id", "status", "attemptCount", "checkpoint", "state" FROM "agent_executions"
    WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3`, [owner.executionId, owner.userId, owner.sessionId])
  if (rows.rows.length !== 1) return null
  const execution = record(rows.rows[0]), state = record(execution?.state), marker = record(state?.scheduledTaskGraphContinuation)
  const completedReport = checkpointStage === "audit_completed_report"
  if (!execution || execution.id !== owner.executionId || Number(execution.attemptCount) !== owner.executionAttemptCount
    || (completedReport ? execution.status !== "completed" || execution.checkpoint !== "completed" || state?.nextStage !== "completed"
      || !parseScheduledAuditReport(state?.report)
      : execution.status !== "running" || execution.checkpoint !== checkpointStage || state?.nextStage !== checkpointStage)
    || !state || !marker || marker.key !== handoffKey || marker.snapshotDigest !== receipt.snapshotDigest
    || marker.graphRevision !== receipt.analyzeGraphRevision || marker.evidenceDigest !== receipt.evidenceDigest) return null
  const allowTurnLeaseDrift = checkpointStage !== "prepare"
  const computed = analyzeCheckpointDigest(allowTurnLeaseDrift ? { ...state, nextStage: "prepare" } : state,
    receipt, handoffKey, allowTurnLeaseDrift)
  if (!computed) return null
  const scored = state.scoredJobs
  const eligible = Array.isArray(scored) ? scored.map(value => { const row = record(value); return { job: record(row?.job), score: row?.score } })
    .filter(value => value.job && typeof value.job.id === "string" && Number.isSafeInteger(value.score) && Number(value.score) >= automation.minScore)
    .slice(0, automation.dailyCap).map(value => String(value.job!.id)) : null
  return eligible ? { checkpointDigest: computed, eligibleJobIds: eligible } : null
}

function analyzeCheckpointDigest(state: Row, receipt: ScheduledTaskGraphContinuationReceipt, handoffKey: string, allowTurnLeaseDrift: boolean): string | null {
  const marker = record(state.scheduledTaskGraphContinuation), scouted = state.scoutedJobs, scored = state.scoredJobs
  if (state.nextStage !== "prepare" || !marker || !Array.isArray(scouted) || !Array.isArray(scored) || !safeCount(state.analysisFailed)) return null
  const owner = receipt.owner, stableOwner = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount]
  if (marker.key !== handoffKey || marker.snapshotDigest !== receipt.snapshotDigest || marker.graphRevision !== receipt.analyzeGraphRevision
    || marker.evidenceDigest !== receipt.evidenceDigest || !(allowTurnLeaseDrift ? sameStableOwner(marker.owner, owner) : same(marker.owner, owner))) return null
  const scoutedIds = new Set<string>()
  for (const value of scouted) { const job = record(value); if (!job || !validId(job.id) || job.userId !== owner.userId || scoutedIds.has(job.id)) return null; scoutedIds.add(job.id) }
  if (Number(state.analysisFailed) + scored.length !== scoutedIds.size) return null
  const scoredRows: Row[] = [], seen = new Set<string>()
  for (const value of scored) {
    const row = record(value), job = record(row?.job)
    if (!row || !job || !validId(job.id) || job.userId !== owner.userId || !scoutedIds.has(job.id) || seen.has(job.id)
      || !Number.isSafeInteger(row.score) || Number(row.score) < 0 || Number(row.score) > 100 || !stringArray(row.matchedKeywords)
      || !stringArray(row.missingKeywords) || typeof row.recommendation !== "string" || row.recommendation.length > 8192) return null
    const hasFence = Object.hasOwn(row, "analysisFenceAt")
    if (hasFence && (typeof row.analysisFenceAt !== "string" || !Number.isFinite(Date.parse(row.analysisFenceAt)))) return null
    if (Reflect.ownKeys(row).some(key => typeof key !== "string" || !["job", "score", "matchedKeywords", "missingKeywords", "recommendation", "analysisFenceAt"].includes(key))
      || ["job", "score", "matchedKeywords", "missingKeywords", "recommendation", ...(hasFence ? ["analysisFenceAt"] : [])].some(key => !Object.hasOwn(row, key))) return null
    seen.add(job.id)
    scoredRows.push({ jobId: job.id, score: row.score, matchedKeywords: [...row.matchedKeywords], missingKeywords: [...row.missingKeywords], recommendation: row.recommendation, ...(hasFence ? { analysisFenceAt: row.analysisFenceAt } : {}) })
  }
  const projection = { owner: stableOwner, snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest,
    analyzeGraphRevision: receipt.analyzeGraphRevision, analysisFailed: state.analysisFailed, scoredJobs: scoredRows }
  return createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")
}

function sameStableOwner(value: unknown, owner: ScheduledTaskGraphContinuationReceipt["owner"]): boolean {
  const row = record(value)
  return Boolean(row && exact(row, ["executionAttemptCount", "executionId", "rootAttemptCount", "rootTaskId", "sessionId", "turnId", "turnLeaseOwnerId", "turnLeaseVersion", "userId"])
    && validId(row.turnLeaseOwnerId) && positive(row.turnLeaseVersion)
    && same([row.userId, row.sessionId, row.turnId, row.rootTaskId, row.rootAttemptCount, row.executionId, row.executionAttemptCount],
      [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount]))
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const proto = Object.getPrototypeOf(parsed); return proto === Object.prototype || proto === null ? parsed as Row : null } catch { return null }
}
function same(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
function exact(value: Row, keys: readonly string[]): boolean { const actual = Reflect.ownKeys(value); return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key)) }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function safeCount(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string") }
