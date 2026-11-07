import type pg from "pg"
import { CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL, type TerminalCallProjection } from "./pg-store-expiry-historical-wait-binding.js"
import { readChildWaitTerminalCallProjections } from "./pg-store-expiry-historical-wait-projections.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Scope = Readonly<{ id: string; userId: string; sessionId: string; turnId: string; rootTaskId: string; ownerId: string; attemptCount: number; leaseExpiresAt: Date }>
type Candidate = Readonly<{ waitId: string; sourceStepId: string; sourceAttempt: number; continuationStepId: string; continuationOrdinal: number; continuationWaitCallCount: number }>

function completedStepEventSql(owner: "owner" | "task"): string { return `((SELECT COUNT(*) FROM "agent_events" AS completedEvent
  WHERE completedEvent."sessionId" = ${owner}."sessionId" AND completedEvent."turnId" = ${owner}."turnId" AND completedEvent."taskId" = ${owner}."id"
    AND completedEvent."type" = 'step.completed' AND completedEvent."actor" = 'subagent' AND completedEvent."itemId" IS NULL
    AND completedEvent."correlationId" = continuation."id"
    AND completedEvent."idempotencyKey" = 'task:' || ${owner}."id" || ':event:step-completed:' || continuation."id"
    AND (completedEvent."payload" = jsonb_build_object('stepId', continuation."id", 'status', 'completed', 'taskId', ${owner}."id")
      OR (jsonb_typeof(completedEvent."payload") = 'object'
        AND jsonb_typeof(completedEvent."payload"->'toolCallCount') = 'number'
        AND completedEvent."payload"->>'toolCallCount' ~ '^(0|[1-9][0-9]?)$'
        AND (completedEvent."payload"->>'toolCallCount')::integer BETWEEN 0 AND 32
        AND completedEvent."payload" = jsonb_build_object('stepId', continuation."id", 'status', 'completed',
          'toolCallCount', completedEvent."payload"->'toolCallCount', 'taskId', ${owner}."id")))) = 1)` }

const COMPLETED_SUCCESSOR_SQL = `EXISTS (SELECT 1 FROM "agent_wait_conditions" AS completedWait
  JOIN "agent_steps" AS source ON source."id" = completedWait."stepId" AND source."sessionId" = completedWait."sessionId"
    AND source."turnId" = completedWait."turnId" AND source."taskId" = completedWait."parentTaskId"
  JOIN "agent_steps" AS continuation ON continuation."sessionId" = source."sessionId" AND continuation."turnId" = source."turnId"
    AND continuation."taskId" = source."taskId" AND continuation."attempt" = source."attempt"
    AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
      WHERE later."sessionId" = source."sessionId" AND later."turnId" = source."turnId" AND later."taskId" = source."taskId"
        AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
  WHERE completedWait."id" = proof.value->'sourceWait'->>'waitId'
    AND completedWait."parentTaskId" = owner."id" AND completedWait."sessionId" = owner."sessionId"
    AND completedWait."turnId" = owner."turnId" AND completedWait."userId" = session."userId"
    AND completedWait."status" IN ('ready', 'timed_out') AND completedWait."suspendedAt" IS NOT NULL AND completedWait."consumedAt" IS NOT NULL
    AND source."id" = proof.value->'sourceWait'->>'sourceStepId' AND source."attempt" = owner."attemptCount"
    AND source."attempt" = (proof.value->'sourceWait'->>'sourceAttempt')::integer
    AND source."status" IN ('waiting_for_tool', 'completed')
    AND continuation."attempt" = owner."attemptCount" AND continuation."status" = 'completed'
    AND continuation."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current
      WHERE current."sessionId" = owner."sessionId" AND current."turnId" = owner."turnId"
        AND current."taskId" = owner."id" AND current."attempt" = owner."attemptCount")
    AND completedWait."id" = (SELECT latest."id" FROM "agent_wait_conditions" AS latest
      JOIN "agent_steps" AS latestStep ON latestStep."id" = latest."stepId" AND latestStep."sessionId" = latest."sessionId"
        AND latestStep."turnId" = latest."turnId" AND latestStep."taskId" = owner."id" AND latestStep."attempt" = owner."attemptCount"
      WHERE latest."parentTaskId" = owner."id" AND latest."sessionId" = owner."sessionId" AND latest."turnId" = owner."turnId"
      ORDER BY latestStep."ordinal" DESC, latest."createdAt" DESC, latest."id" DESC LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM "agent_wait_conditions" AS pendingWait
      JOIN "agent_steps" AS pendingStep ON pendingStep."id" = pendingWait."stepId" AND pendingStep."sessionId" = pendingWait."sessionId"
        AND pendingStep."turnId" = pendingWait."turnId" AND pendingStep."taskId" = owner."id" AND pendingStep."attempt" = owner."attemptCount"
      WHERE pendingWait."parentTaskId" = owner."id" AND pendingWait."sessionId" = owner."sessionId"
        AND pendingWait."turnId" = owner."turnId" AND pendingWait."consumedAt" IS NULL)
    AND ${completedStepEventSql("owner")})`

const CANDIDATE_SQL = `SELECT wait."id" AS "waitId", source."id" AS "sourceStepId", source."attempt" AS "sourceAttempt",
    continuation."id" AS "continuationStepId", continuation."ordinal" AS "continuationOrdinal",
    (SELECT COUNT(*)::int FROM "agent_items" AS waitCall WHERE waitCall."sessionId" = continuation."sessionId"
      AND waitCall."turnId" = continuation."turnId" AND waitCall."taskId" = continuation."taskId"
      AND waitCall."stepId" = continuation."id" AND waitCall."type" = 'tool_call'
      AND waitCall."content"->>'toolName' = 'wait_subagents') AS "continuationWaitCallCount"
  FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $5
  JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    AND turn."userId" = session."userId" AND turn."rootTaskId" = task."rootTaskId"
  JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
  JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
    AND wait."turnId" = task."turnId" AND wait."userId" = session."userId"
  JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId"
    AND source."turnId" = wait."turnId" AND source."taskId" = task."id"
  JOIN "agent_steps" AS continuation ON continuation."sessionId" = source."sessionId" AND continuation."turnId" = source."turnId"
    AND continuation."taskId" = source."taskId" AND continuation."attempt" = source."attempt"
    AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
      WHERE later."sessionId" = source."sessionId" AND later."turnId" = source."turnId" AND later."taskId" = source."taskId"
        AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
  WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
    AND task."status" = 'running' AND task."parentTaskId" IS NOT NULL AND task."leaseOwner" = $6
    AND task."attemptCount" = $7 AND task."leaseExpiresAt" = $8 AND task."leaseExpiresAt" <= $9
    AND task."interruptRequestedAt" IS NULL AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= $9)
    AND session."status" NOT IN ('aborted', 'archived') AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
    AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed') AND root."interruptRequestedAt" IS NULL
    AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NOT NULL
    AND source."attempt" = task."attemptCount" AND source."status" IN ('waiting_for_tool', 'completed')
    AND continuation."attempt" = task."attemptCount" AND continuation."status" = 'completed'
    AND continuation."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current
      WHERE current."sessionId" = task."sessionId" AND current."turnId" = task."turnId"
        AND current."taskId" = task."id" AND current."attempt" = task."attemptCount")
    AND wait."id" = (SELECT latest."id" FROM "agent_wait_conditions" AS latest
      JOIN "agent_steps" AS latestStep ON latestStep."id" = latest."stepId" AND latestStep."sessionId" = latest."sessionId"
        AND latestStep."turnId" = latest."turnId" AND latestStep."taskId" = task."id" AND latestStep."attempt" = task."attemptCount"
      WHERE latest."parentTaskId" = task."id" AND latest."sessionId" = task."sessionId" AND latest."turnId" = task."turnId"
      ORDER BY latestStep."ordinal" DESC, latest."createdAt" DESC, latest."id" DESC LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM "agent_wait_conditions" AS pendingWait
      JOIN "agent_steps" AS pendingStep ON pendingStep."id" = pendingWait."stepId" AND pendingStep."sessionId" = pendingWait."sessionId"
        AND pendingStep."turnId" = pendingWait."turnId" AND pendingStep."taskId" = task."id" AND pendingStep."attempt" = task."attemptCount"
      WHERE pendingWait."parentTaskId" = task."id" AND pendingWait."sessionId" = task."sessionId"
        AND pendingWait."turnId" = task."turnId" AND pendingWait."consumedAt" IS NULL)
    AND ${completedStepEventSql("task")}
  ORDER BY source."ordinal" DESC, wait."createdAt" DESC, wait."id" DESC LIMIT 2 FOR UPDATE OF wait, source, continuation`

function scopeOf(task: Row): Scope | null {
  const attemptCount = Number(task.attemptCount)
  if (typeof task.id !== "string" || !task.id || typeof task.userId !== "string" || !task.userId
    || typeof task.sessionId !== "string" || !task.sessionId || typeof task.turnId !== "string" || !task.turnId
    || typeof task.rootTaskId !== "string" || !task.rootTaskId || typeof task.leaseOwner !== "string" || !task.leaseOwner
    || !Number.isSafeInteger(attemptCount) || attemptCount < 1 || !(task.leaseExpiresAt instanceof Date)
    || !Number.isFinite(task.leaseExpiresAt.getTime()) || task.status !== "running" || task.parentTaskId == null
    || task.interruptRequestedAt != null) return null
  return { id: task.id, userId: task.userId, sessionId: task.sessionId, turnId: task.turnId, rootTaskId: task.rootTaskId,
    ownerId: task.leaseOwner, attemptCount, leaseExpiresAt: task.leaseExpiresAt }
}

function exactSourceProjections(projections: readonly TerminalCallProjection[], candidate: Candidate): {
  source: TerminalCallProjection | null; claim: TerminalCallProjection | null; valid: boolean
} {
  const sameWait = projections.filter(projection => projection.sourceWait.waitId === candidate.waitId
    && projection.sourceWait.sourceStepId === candidate.sourceStepId && projection.sourceWait.sourceAttempt === candidate.sourceAttempt)
  const sources = sameWait.filter(projection => projection.sourceWait.claimKeyDigest === null)
  const claims = sameWait.filter(projection => projection.sourceWait.claimKeyDigest !== null)
  const source = sources.length === 1 ? sources[0]! : null
  const claim = claims.length === 1 ? claims[0]! : null
  const claimValid = candidate.continuationWaitCallCount === 0 ? claims.length === 0
    : candidate.continuationWaitCallCount === 1 && claims.length === 1 && claim?.stepId === candidate.continuationStepId
      && claim.attempt === candidate.sourceAttempt && Boolean(claim.resultItemId && claim.stepToolChain)
  return { source, claim, valid: source !== null && claimValid }
}

async function historicalBindingAccepts(client: Client, scope: Scope, projection: TerminalCallProjection): Promise<boolean> {
  const result = await client.query<{ accepted: boolean }>(`WITH proof AS (SELECT $9::jsonb AS value)
    SELECT ((${CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL}) AND ${COMPLETED_SUCCESSOR_SQL}) AS "accepted"
    FROM proof JOIN "sub_agent_tasks" AS owner ON owner."id" = $2 AND owner."sessionId" = $1 AND owner."turnId" = $3
      AND owner."rootTaskId" = $4 AND owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7
    JOIN "agent_sessions" AS session ON session."id" = owner."sessionId" AND session."userId" = $8
    JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId"
      AND turn."userId" = session."userId" AND turn."rootTaskId" = owner."rootTaskId"
    JOIN "agent_steps" AS callStep ON callStep."id" = proof.value->>'stepId' AND callStep."sessionId" = owner."sessionId"
      AND callStep."turnId" = owner."turnId" AND callStep."taskId" = owner."id"
    JOIN "agent_items" AS callItem ON callItem."id" = proof.value->>'callItemId' AND callItem."sessionId" = owner."sessionId"
      AND callItem."turnId" = owner."turnId" AND callItem."taskId" = owner."id" AND callItem."stepId" = callStep."id"
    JOIN "agent_events" AS itemStarted ON itemStarted."sessionId" = owner."sessionId" AND itemStarted."turnId" = owner."turnId"
      AND itemStarted."taskId" = owner."id" AND itemStarted."itemId" = callItem."id" AND itemStarted."type" = 'item.started'
      AND itemStarted."actor" = 'subagent' AND itemStarted."correlationId" = callStep."id"
      AND itemStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || callItem."id"
      AND itemStarted."payload" = jsonb_build_object('itemId', callItem."id", 'type', 'tool_call', 'phase', NULL)
    JOIN "agent_events" AS started ON started."id" = proof.value->>'startEventId' AND started."sessionId" = owner."sessionId"
      AND started."turnId" = owner."turnId" AND started."taskId" = owner."id" AND started."itemId" = callItem."id"
      AND started."type" = 'tool_call.started' AND started."actor" = 'subagent'
      AND started."correlationId" = callItem."content"->>'toolCallId' AND started."causationId" = itemStarted."id"
      AND started."sequence" > itemStarted."sequence"
      AND started."idempotencyKey" = CASE WHEN proof.value->'sourceWait'->'claimKeyDigest' = 'null'::jsonb
        THEN 'task:' || owner."id" || ':event:tool-started:' || (callItem."content"->>'toolCallId')
        ELSE 'task:' || owner."id" || ':event:child-wait-claim:' || callStep."attempt"::text || ':' || callStep."id" END
      AND started."payload" = jsonb_build_object('toolCallId', callItem."content"->>'toolCallId',
        'toolName', 'wait_subagents', 'taskId', owner."id")
    WHERE owner."status" = 'running' AND owner."parentTaskId" IS NOT NULL AND owner."interruptRequestedAt" IS NULL
      AND owner."leaseExpiresAt" <= clock_timestamp() AND (owner."nextAttemptAt" IS NULL OR owner."nextAttemptAt" <= clock_timestamp())`,
  [scope.sessionId, scope.id, scope.turnId, scope.rootTaskId, scope.ownerId, scope.attemptCount, scope.leaseExpiresAt,
    scope.userId, JSON.stringify(projection)])
  return result.rows.length === 1 && result.rows[0]?.accepted === true
}

/** Proves a consumed current-attempt wait with its completed successor before skipping unconsumed-wait repair. */
export async function hasProvenCompletedConsumedWait(client: Client, task: Row, now: Date): Promise<boolean> {
  const scope = scopeOf(task)
  if (!scope || !(now instanceof Date) || !Number.isFinite(now.getTime()) || scope.leaseExpiresAt > now) return false
  const candidates = await client.query<Candidate>(CANDIDATE_SQL, [scope.id, scope.sessionId, scope.turnId, scope.rootTaskId,
    scope.userId, scope.ownerId, scope.attemptCount, scope.leaseExpiresAt, now])
  if (candidates.rows.length !== 1) return false
  const candidate = candidates.rows[0]!
  if (typeof candidate.waitId !== "string" || !candidate.waitId || typeof candidate.sourceStepId !== "string" || !candidate.sourceStepId
    || typeof candidate.continuationStepId !== "string" || !candidate.continuationStepId
    || Number(candidate.sourceAttempt) !== scope.attemptCount || !Number.isSafeInteger(Number(candidate.continuationOrdinal))
    || !Number.isSafeInteger(Number(candidate.continuationWaitCallCount)) || Number(candidate.continuationWaitCallCount) < 0
    || Number(candidate.continuationWaitCallCount) > 1) return false
  const normalized: Candidate = { ...candidate, sourceAttempt: Number(candidate.sourceAttempt),
    continuationOrdinal: Number(candidate.continuationOrdinal), continuationWaitCallCount: Number(candidate.continuationWaitCallCount) }
  const projections = await readChildWaitTerminalCallProjections(client as pg.PoolClient, task)
  const selected = exactSourceProjections(projections, normalized)
  if (!selected.valid || !selected.source || !await historicalBindingAccepts(client, scope, selected.source)) return false
  if (selected.claim && !await historicalBindingAccepts(client, scope, selected.claim)) return false
  return true
}
