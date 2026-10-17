import type pg from "pg"
import {
  OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION,
  isValidRootObjectiveHistoryTerminalReceipt,
  projectRootObjectiveHistoryForBackfill,
  updateRootObjectiveHistoryProjection,
  type RootObjectiveHistoryIdentity,
} from "./objective-history-projection.js"

const INDEX_NAME = "agent_turns_objective_history"
const MAX_TURNS_PER_BATCH = 100
const MAX_BATCHES_PER_INVOCATION = 20
const VERIFY_STATEMENT_TIMEOUT_MS = 20_000
const VERIFY_DEADLINE_MS = 30_000
const TERMINAL_TYPES = ["turn.completed", "turn.failed", "turn.interrupted"]
type Client = pg.PoolClient
type Candidate = RootObjectiveHistoryIdentity & Readonly<{
  inputJsonbText: string | null
  source: unknown
  goal: unknown
  successCriteriaJsonbText: string | null
}>

export type ObjectiveHistoryBackfillOptions = Readonly<{ batchSize?: number; maxBatches?: number }>
export type ObjectiveHistoryBackfillReport = Readonly<{
  batches: number
  evaluated: number
  unindexable: number
  ineligible: number
  conflicts: number
  terminalIneligible: number
  nextCursor: string | null
  verificationBatches: number
  transactions: number
  workTransactions: number
  verificationComplete: boolean
  capped: boolean
  verificationFailed: boolean
  ready: boolean
}>

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback
}

async function transaction<T>(client: Client, work: () => Promise<T>): Promise<T> {
  await client.query("BEGIN")
  try {
    const value = await work()
    await client.query("COMMIT")
    return value
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  }
}

async function setReadiness(client: Client, ready: boolean): Promise<boolean> {
  const result = await client.query(`UPDATE "agent_objective_history_index_readiness"
    SET "isReady" = $1, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "indexName" = $2 AND "semanticsVersion" = $3`, [ready, INDEX_NAME, OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION])
  return result.rowCount === 1
}

const ELIGIBLE_FROM = `FROM "agent_turns" AS turn
  JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
    AND root."turnId" = turn."id" AND root."rootTaskId" = root."id"`
const ELIGIBLE_JOIN = `${ELIGIBLE_FROM}
  WHERE turn."rootTaskId" IS NOT NULL AND root."parentTaskId" IS NULL
    AND root."role" = 'orchestrator' AND root."taskType" = 'root'`

async function candidates(client: Client, cursor: string | null, batchSize: number): Promise<Candidate[]> {
  const result = await client.query<Candidate>(`SELECT turn."id" AS "turnId", turn."sessionId", turn."userId",
      turn."rootTaskId", turn."input"::text AS "inputJsonbText", turn."source", root."goal",
      root."successCriteria"::text AS "successCriteriaJsonbText"
    ${ELIGIBLE_JOIN} AND turn."objectiveIndexSemanticsVersion" IS DISTINCT FROM $1
      AND ($2::text IS NULL OR turn."id" > $2)
    ORDER BY turn."id" ASC LIMIT $3`, [OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION, cursor, batchSize])
  return result.rows
}

async function projectCandidate(client: Client, candidate: Candidate): Promise<{
  evaluated: number; unindexable: number; ineligible: number; conflicts: number; terminalIneligible: number;
}> {
  const identity: RootObjectiveHistoryIdentity = {
    turnId: candidate.turnId, sessionId: candidate.sessionId, userId: candidate.userId, rootTaskId: candidate.rootTaskId,
  }
  const outcome = await projectRootObjectiveHistoryForBackfill(client, identity, candidate)
  if (outcome.kind === "retryable_conflict") return { evaluated: 0, unindexable: 0, ineligible: 0, conflicts: 1, terminalIneligible: 0 }
  if (outcome.kind === "ineligible") return { evaluated: 0, unindexable: 0, ineligible: 1, conflicts: 0, terminalIneligible: 0 }
  const event = await client.query<{ id: string }>(`SELECT "id" FROM "agent_events"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = ANY($4::text[])
    ORDER BY "sequence" DESC LIMIT 1 FOR UPDATE`, [identity.sessionId, identity.turnId, identity.rootTaskId, TERMINAL_TYPES])
  const terminalIneligible = event.rows[0]
    && !await updateRootObjectiveHistoryProjection(client, identity, { terminalEventId: event.rows[0].id }) ? 1 : 0
  return {
    evaluated: 1,
    unindexable: outcome.kind === "evaluated_unindexable" ? 1 : 0,
    ineligible: 0, conflicts: 0, terminalIneligible,
  }
}

async function hasPendingCandidates(client: Client, cursor: string | null = null): Promise<boolean> {
  const result = await client.query<{ pending: boolean }>(`SELECT EXISTS (SELECT 1 ${ELIGIBLE_JOIN}
    AND turn."objectiveIndexSemanticsVersion" IS DISTINCT FROM $1
    AND ($2::text IS NULL OR turn."id" > $2)) AS "pending"`, [OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION, cursor])
  return result.rows[0]?.pending === true
}

type VerificationResult = Readonly<{ consistent: boolean; complete: boolean }>
class TerminalIneligibleBatchError extends Error {}
class VerificationDeadlineError extends Error {}
class VerificationMismatchError extends Error {}

async function setVerificationTimeout(client: Client, deadline: number): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new VerificationDeadlineError("Objective-history verification deadline exceeded")
  await client.query("SELECT set_config('statement_timeout', $1, true)", [`${Math.max(1, Math.min(VERIFY_STATEMENT_TIMEOUT_MS, Math.floor(remaining)))}ms`])
}

function isRetryableVerificationAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "57014" || error.code === "40001" || error.code === "40P01")
}

async function consistencyPass(client: Client): Promise<VerificationResult> {
  try {
    return await transaction(client, async () => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
      await client.query(`SET LOCAL statement_timeout = '${VERIFY_STATEMENT_TIMEOUT_MS}ms'`)
      const deadline = Date.now() + VERIFY_DEADLINE_MS
      await setVerificationTimeout(client, deadline)
      const check = await client.query<{ consistent: boolean }>(`WITH eligible AS (
        SELECT turn."id", turn."sessionId", turn."rootTaskId",
          turn."objectiveDigest", turn."canonicalOriginDigest", turn."objectiveIndexSemanticsVersion",
          turn."terminalEventSequence", turn."terminalEventAt"
        ${ELIGIBLE_FROM}
        WHERE turn."rootTaskId" IS NOT NULL AND root."parentTaskId" IS NULL
          AND root."role" = 'orchestrator' AND root."taskType" = 'root')
        SELECT NOT EXISTS (SELECT 1 FROM eligible turn WHERE
          turn."objectiveIndexSemanticsVersion" IS DISTINCT FROM $1
          OR (turn."objectiveDigest" IS NOT NULL AND turn."objectiveDigest" !~ '^[0-9a-f]{64}$')
          OR (turn."canonicalOriginDigest" IS NOT NULL AND
            (turn."canonicalOriginDigest" !~ '^[0-9a-f]{64}$' OR turn."objectiveDigest" IS NULL))
          OR ((turn."terminalEventSequence" IS NULL) IS DISTINCT FROM (turn."terminalEventAt" IS NULL))
          OR (turn."terminalEventSequence" IS NOT NULL AND (SELECT COUNT(*) FROM "agent_events" event
            WHERE event."sessionId" = turn."sessionId"
              AND event."turnId" = turn."id" AND event."taskId" = turn."rootTaskId"
              AND event."sequence" = turn."terminalEventSequence" AND event."createdAt" = turn."terminalEventAt"
              AND event."type" = ANY($2::text[])) <> 1)) AS "consistent"`,
      [OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION, TERMINAL_TYPES])
      if (check.rows[0]?.consistent !== true) throw new VerificationMismatchError("Objective-history projection witness found")

      let cursor: string | null = null
      while (true) {
        await setVerificationTimeout(client, deadline)
        const pageRows: (RootObjectiveHistoryIdentity & { terminalEventId: string })[] = (await client.query<RootObjectiveHistoryIdentity & { terminalEventId: string }>(`SELECT
            turn."id" AS "turnId", turn."sessionId", turn."userId", turn."rootTaskId", receipt."id" AS "terminalEventId"
          ${ELIGIBLE_FROM}
          JOIN LATERAL (SELECT event."id" FROM "agent_events" event WHERE event."sessionId" = turn."sessionId"
            AND event."turnId" = turn."id" AND event."taskId" = root."id"
            AND event."sequence" = turn."terminalEventSequence" AND event."createdAt" = turn."terminalEventAt"
            AND event."type" = ANY($2::text[]) ORDER BY event."id" LIMIT 1) receipt ON true
          WHERE turn."rootTaskId" IS NOT NULL AND root."parentTaskId" IS NULL
            AND root."role" = 'orchestrator' AND root."taskType" = 'root'
            AND turn."terminalEventSequence" IS NOT NULL AND ($1::text IS NULL OR turn."id" > $1)
          ORDER BY turn."id" ASC LIMIT $3`, [cursor, TERMINAL_TYPES, MAX_TURNS_PER_BATCH])).rows
        for (const row of pageRows) {
          await setVerificationTimeout(client, deadline)
          if (!await isValidRootObjectiveHistoryTerminalReceipt(client, row, row.terminalEventId)) {
            throw new VerificationMismatchError("Objective-history terminal receipt is invalid")
          }
        }
        if (pageRows.length < MAX_TURNS_PER_BATCH) break
        cursor = pageRows[pageRows.length - 1]!.turnId
      }
      await setVerificationTimeout(client, deadline)
      if (!await setReadiness(client, true)) throw new VerificationMismatchError("Objective-history readiness row is missing")
      return { consistent: true, complete: true }
    })
  } catch (error) {
    if (error instanceof VerificationMismatchError) return { consistent: false, complete: true }
    if (error instanceof VerificationDeadlineError || isRetryableVerificationAbort(error)) return { consistent: false, complete: false }
    throw error
  }
}

/** Replays missing historical projections in bounded, independently committed keyset batches. */
export async function backfillObjectiveHistoryProjection(
  pool: Pick<pg.Pool, "connect">,
  options: ObjectiveHistoryBackfillOptions = {},
): Promise<ObjectiveHistoryBackfillReport> {
  const batchSize = boundedInteger(options.batchSize, MAX_TURNS_PER_BATCH, MAX_TURNS_PER_BATCH)
  const maxBatches = boundedInteger(options.maxBatches, MAX_BATCHES_PER_INVOCATION, MAX_BATCHES_PER_INVOCATION)
  const client = await pool.connect()
  let batches = 0, evaluated = 0, unindexable = 0, ineligible = 0, conflicts = 0, terminalIneligible = 0
  let cursor: string | null = null, pending = false, verificationFailed = false, ready = false
  let verificationBatches = 0, verificationComplete = false
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [INDEX_NAME + ":" + OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION])
    const reset = await transaction(client, () => setReadiness(client, false))
    if (!reset) throw new Error("The exact objective-history readiness row is missing")
    while (batches < maxBatches) {
      if (!await hasPendingCandidates(client, cursor)) break
      let page: Candidate[]
      const pageCounts = { evaluated: 0, unindexable: 0, ineligible: 0, conflicts: 0, terminalIneligible: 0 }
      try {
        page = await transaction(client, async () => {
          const rows = await candidates(client, cursor, batchSize)
          for (const row of rows) {
            const counts = await projectCandidate(client, row)
            pageCounts.evaluated += counts.evaluated; pageCounts.unindexable += counts.unindexable
            pageCounts.ineligible += counts.ineligible; pageCounts.conflicts += counts.conflicts
            pageCounts.terminalIneligible += counts.terminalIneligible
            if (counts.terminalIneligible) throw new TerminalIneligibleBatchError()
          }
          return rows
        })
      } catch (error) {
        if (!(error instanceof TerminalIneligibleBatchError)) throw error
        batches += 1
        terminalIneligible += pageCounts.terminalIneligible
        break
      }
      evaluated += pageCounts.evaluated; unindexable += pageCounts.unindexable
      ineligible += pageCounts.ineligible; conflicts += pageCounts.conflicts
      terminalIneligible += pageCounts.terminalIneligible
      batches += 1
      if (!page.length) break
      cursor = page[page.length - 1]!.turnId
    }
    pending = await hasPendingCandidates(client)
    const verificationEligible = !pending && !conflicts && !terminalIneligible
    if (verificationEligible && batches < maxBatches) {
      verificationBatches = 1
      const verification = await consistencyPass(client)
      verificationComplete = verification.complete
      ready = verification.complete && verification.consistent
      verificationFailed = !ready
    } else if (terminalIneligible) verificationFailed = true
    const capped = batches === maxBatches && (pending || (verificationEligible && !verificationComplete))
    return {
      batches, evaluated, unindexable, ineligible, conflicts, terminalIneligible, nextCursor: cursor,
      verificationBatches, transactions: 1 + batches + verificationBatches,
      workTransactions: batches + verificationBatches, verificationComplete,
      capped, verificationFailed, ready,
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [INDEX_NAME + ":" + OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION]).catch(() => undefined)
    client.release()
  }
}
