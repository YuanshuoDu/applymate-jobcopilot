import { Buffer } from "node:buffer"
import type pg from "pg"
import type { ContextHistoryEntry } from "../context/step-context-builder.js"
import { deriveNativeVerificationObjective } from "./native-verification-pg-bindings.js"
import {
  nativeVerificationControlMatchesTask, parseNativeVerificationControl,
} from "./native-verification-contract.js"
import { parseNativeVerificationPacket } from "./native-verification-packet.js"
import { parseNativeVerificationReport } from "./native-verification-report.js"

export const NATIVE_VERIFICATION_ADVISORY_ID_PREFIX = "native-verification-advisory:"
const MAX_TURNS = 8, MAX_CONTROLS = 64, MAX_ADVISORIES = 3, MAX_ENTRY_BYTES = 8 * 1024, MAX_TOTAL_BYTES = 24 * 1024
type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
export type HistoricalAdvisoryScope = Readonly<{ userId: string; sessionId: string; turnId: string }>
export type HistoricalAdvisoryInput = Readonly<{
  lease: HistoricalAdvisoryScope
  /** Kept for loader compatibility and validation; canonical order comes from turn.started sequence. */
  currentTurnCreatedAt: Date
  currentInput: unknown
  currentRootTaskId: string | null
  existingHistory?: readonly ContextHistoryEntry[]
  additionalHistory?: readonly Readonly<{ id: string; content: unknown; sequence?: bigint | null }>[]
}>

function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}

function exactCriteria(criteria: unknown, objective: readonly string[]): boolean {
  return Array.isArray(criteria) && criteria.length === objective.length
    && criteria.every((item, index) => record(item)?.requirement === objective[index])
}

function sessionSequence(value: unknown): bigint | null {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null
  const text = String(value)
  if (!/^[1-9]\d*$/.test(text)) return null
  try { return BigInt(text) } catch { return null }
}

function projectedEntry(goal: string, criterion: Row): ContextHistoryEntry | null {
  const references = Array.isArray(criterion.evidenceReferenceIds) ? criterion.evidenceReferenceIds : []
  const content = {
    type: "historical_native_verification_advisory",
    label: "Historical advisory only",
    goal,
    criterionId: criterion.criterionId,
    requirement: criterion.requirement,
    disposition: criterion.disposition,
    reasonCode: criterion.reasonCode,
    evidenceReferenceIds: references.map((_reference, index) => `prior-evidence-${index + 1}`),
  }
  const entry = { id: `${NATIVE_VERIFICATION_ADVISORY_ID_PREFIX}0`, content }
  try { return Buffer.byteLength(JSON.stringify(entry), "utf8") <= MAX_ENTRY_BYTES ? entry : null } catch { return null }
}

/** Reads validated advisory-only failures from earlier owned Turns. It never locks or schedules controls. */
export async function hydrateNativeVerificationHistoricalAdvisories(
  client: Queryable, input: HistoricalAdvisoryInput,
): Promise<ContextHistoryEntry[]> {
  const { lease } = input
  const prior = (input.existingHistory ?? []).filter(item => !item.id.startsWith(NATIVE_VERIFICATION_ADVISORY_ID_PREFIX))
  const seenHistory = new Set(prior.map(item => item.id))
  for (const item of input.additionalHistory ?? []) if (!seenHistory.has(item.id)) {
    prior.push({ id: item.id, content: item.content }); seenHistory.add(item.id)
  }
  const currentDate = input.currentTurnCreatedAt
  if (!(currentDate instanceof Date) || !Number.isFinite(currentDate.getTime())
    || !lease.userId || !lease.sessionId || !lease.turnId) return prior

  let currentRoot: Readonly<{ goal: unknown; successCriteria: unknown }> | undefined
  if (input.currentRootTaskId !== null) {
    if (!input.currentRootTaskId.trim()) return prior
    const root = await client.query<Readonly<{ goal: unknown; successCriteria: unknown }>>(`SELECT root."goal", root."successCriteria"
      FROM "sub_agent_tasks" AS root JOIN "agent_sessions" AS session ON session."id" = root."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = root."turnId" AND turn."sessionId" = root."sessionId"
      WHERE root."id" = $1 AND root."sessionId" = $2 AND root."turnId" = $3 AND root."rootTaskId" = $1 AND root."parentTaskId" IS NULL
        AND root."role" = 'orchestrator' AND root."taskType" = 'root' AND turn."rootTaskId" = $1
        AND session."userId" = $4 AND turn."userId" = $4`,
    [input.currentRootTaskId, lease.sessionId, lease.turnId, lease.userId])
    if (root.rows.length !== 1) return prior
    currentRoot = root.rows[0]
  }
  const objective = deriveNativeVerificationObjective(input.currentInput, currentRoot)
  if (!objective) return prior

  const steering = await client.query<{ hasSteer: unknown }>(`SELECT EXISTS (
      SELECT 1 FROM "agent_inputs" WHERE "sessionId" = $1 AND "userId" = $2 AND "targetTurnId" = $3
        AND "delivery" = 'steer' AND "status" IN ('accepted', 'queued', 'consumed') AND "cancelledAt" IS NULL
    ) AS "hasSteer"`, [lease.sessionId, lease.userId, lease.turnId])
  if (steering.rows.length !== 1 || steering.rows[0].hasSteer !== false) return prior

  const turns = await client.query<Row>(`WITH current_start AS (
      SELECT MIN(start_event."sequence") AS "sequence"
      FROM "agent_events" AS start_event
      JOIN "agent_turns" AS current_turn ON current_turn."id" = start_event."turnId" AND current_turn."sessionId" = start_event."sessionId"
      JOIN "agent_sessions" AS current_session ON current_session."id" = current_turn."sessionId"
      WHERE start_event."sessionId" = $1 AND start_event."turnId" = $3 AND start_event."type" = 'turn.started'
        AND start_event."actor" = 'orchestrator' AND start_event."correlationId" = current_turn."id"
        AND current_turn."userId" = $2 AND current_session."userId" = $2
    )
    SELECT turn."id", turn."rootTaskId", prior_start."sequence" AS "startedSequence", current_start."sequence" AS "currentStartedSequence"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
      AND root."turnId" = turn."id" AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
      AND root."role" = 'orchestrator' AND root."taskType" = 'root'
    CROSS JOIN current_start
    JOIN LATERAL (
      SELECT MIN(start_event."sequence") AS "sequence"
      FROM "agent_events" AS start_event
      WHERE start_event."sessionId" = turn."sessionId" AND start_event."turnId" = turn."id" AND start_event."type" = 'turn.started'
        AND start_event."actor" = 'orchestrator' AND start_event."correlationId" = turn."id"
    ) AS prior_start ON prior_start."sequence" < current_start."sequence"
    WHERE turn."sessionId" = $1 AND turn."userId" = $2 AND session."userId" = $2 AND turn."id" <> $3
      AND turn."status" IN ('completed', 'failed', 'interrupted', 'cancelled')
    ORDER BY prior_start."sequence" DESC, turn."id" DESC LIMIT ${MAX_TURNS}`,
  [lease.sessionId, lease.userId, lease.turnId])
  const currentSequence = sessionSequence(turns.rows[0]?.currentStartedSequence)
  if (!currentSequence || turns.rows.some(row => sessionSequence(row.currentStartedSequence) !== currentSequence)) return prior
  const roots = new Map<string, string>()
  for (const row of turns.rows) {
    const startedSequence = sessionSequence(row.startedSequence)
    if (startedSequence && startedSequence < currentSequence && typeof row.id === "string" && row.id !== lease.turnId
      && typeof row.rootTaskId === "string") roots.set(row.id, row.rootTaskId)
  }
  if (!roots.size) return prior

  const controls = await client.query<Row>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
      task."role", task."taskType", task."status", task."attemptCount", task."result", task."failureReason",
      task."expectedOutputSchema", task."context", session."userId" AS "userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."turnId" = ANY($3::text[]) AND task."sessionId" = $1 AND turn."userId" = $2 AND session."userId" = $2
      AND task."role" = 'auditor' AND task."taskType" = 'native_verification'
    ORDER BY turn."createdAt" DESC, task."createdAt" DESC, task."id" ASC LIMIT ${MAX_CONTROLS}`,
  [lease.sessionId, lease.userId, [...roots.keys()]])

  const output: ContextHistoryEntry[] = [], seen = new Set<string>()
  let totalBytes = 0
  for (const row of controls.rows) {
    const rootTaskId = typeof row.turnId === "string" ? roots.get(row.turnId) : undefined
    if (!rootTaskId || row.rootTaskId !== rootTaskId || row.parentTaskId !== rootTaskId || row.status !== "completed"
      || row.failureReason !== null || typeof row.id !== "string" || !Number.isSafeInteger(row.attemptCount) || Number(row.attemptCount) < 1) continue
    const control = parseNativeVerificationControl(row.expectedOutputSchema)
    const task = { id: row.id, userId: row.userId, sessionId: row.sessionId, turnId: row.turnId,
      rootTaskId: row.rootTaskId, parentTaskId: row.parentTaskId, role: row.role }
    if (!control || !nativeVerificationControlMatchesTask(control, task as Parameters<typeof nativeVerificationControlMatchesTask>[1])) continue
    const packet = parseNativeVerificationPacket(row.context, control)
    if (!packet || packet.goal !== objective.goal || !exactCriteria(packet.criteria, objective.criteria)) continue
    const result = record(row.result), report = result?.nativeVerificationReport
    const validated = parseNativeVerificationReport(report, control, packet, Number(row.attemptCount))
    if (!validated) continue
    for (const verdict of validated.criteria) {
      if (verdict.disposition !== "failed" && verdict.disposition !== "uncertain") continue
      const requirement = packet.criteria.find(item => item.criterionId === verdict.criterionId)?.requirement
      if (!requirement) continue
      const entry = projectedEntry(packet.goal, { ...verdict, requirement })
      if (!entry) continue
      const key = JSON.stringify(entry.content)
      if (seen.has(key)) continue
      const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8")
      if (totalBytes + bytes > MAX_TOTAL_BYTES) continue
      seen.add(key); totalBytes += bytes
      output.push({ ...entry, id: `${NATIVE_VERIFICATION_ADVISORY_ID_PREFIX}${output.length}` })
      if (output.length >= MAX_ADVISORIES) return [...prior, ...output]
    }
  }
  return [...prior, ...output]
}
