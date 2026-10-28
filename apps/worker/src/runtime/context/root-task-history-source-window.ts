import { scheduledAutomationHistoryCompatibilitySql } from "../subagents/scheduled-automation-snapshot.js"

export type RootTaskHistoryCrossSessionWindowInput = Readonly<{
  currentSessionId: string; userId: string; currentTurnId: string; currentStartXid8: string
  scheduledCriteria: string | null; objectiveDigest: string; semanticsVersion: number; canonicalOrigin: string
  limit: number
}>

function validIntent(json: string): string {
  return `(jsonb_typeof(${json}) = 'object' AND ${json} ?& ARRAY['kind','version']
    AND (${json} - 'kind' - 'version') = '{}'::jsonb
    AND ${json}->>'kind' = 'interactive_discovery_shortlist' AND ${json}->'version' = '1'::jsonb)`
}

function canonicalOriginMatches(parameter: string): string {
  const input = `turn."input"`, nested = `(${input}->'input')`, source = `turn."source"`
  const outerIntent = `(${input}->'intent')`, nestedIntent = `(${nested}->'intent')`
  return `CASE
    WHEN jsonb_typeof(${input}) IS DISTINCT FROM 'object' THEN FALSE
    WHEN ${input} ? 'input' AND jsonb_typeof(${nested}) IS DISTINCT FROM 'object' THEN FALSE
    WHEN ${source} IS NULL OR ${source} = '' OR ${source} ~ '^[[:space:]]|[[:space:]]$' THEN FALSE
    WHEN ${input} ? 'intent' AND NOT ${validIntent(outerIntent)} THEN FALSE
    WHEN ${nested} ? 'intent' AND NOT ${validIntent(nestedIntent)} THEN FALSE
    WHEN ${input} ? 'intent' OR ${nested} ? 'intent'
      THEN jsonb_build_array(${source}, 'interactive_discovery_shortlist', 1) = ${parameter}::jsonb
    ELSE jsonb_build_array(${source}, 'none') = ${parameter}::jsonb
  END`
}

/** Builds the bounded cross-session candidate window. All DB-derived identity filters precede LIMIT. */
export function buildRootTaskHistoryCrossSessionWindow(input: RootTaskHistoryCrossSessionWindowInput): Readonly<{
  sql: string; values: readonly unknown[]
}> {
  const compatibility = scheduledAutomationHistoryCompatibilitySql("$5")
  const origin = canonicalOriginMatches("$8")
  return {
    sql: `SELECT event."id" AS "terminalEventId", event."sessionId", event."turnId", event."taskId", event."sequence",
        witness."id" AS "terminalWitnessEventId", witness.payload->>'xid8' AS "terminalWitnessXid8",
        COUNT(*) OVER (PARTITION BY event."id") AS "terminalWitnessCount"
      FROM "agent_events" AS event
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      JOIN "sub_agent_tasks" AS task ON task."id" = turn."rootTaskId" AND task."sessionId" = turn."sessionId"
        AND task."turnId" = turn."id" AND task."rootTaskId" = task."id"
      JOIN "agent_sessions" AS current_session ON current_session."id" = $1 AND current_session."userId" = $2
        AND current_session."status" NOT IN ('aborted', 'archived')
      JOIN "agent_sessions" AS source_session ON source_session."id" = event."sessionId"
        AND source_session."userId" = $2 AND source_session."status" NOT IN ('aborted', 'archived')
      JOIN "agent_outbox" AS terminal_dispatch ON terminal_dispatch."id" = ('agent-outbox-' || event."id")
        AND terminal_dispatch."topic" = 'agent.events' AND terminal_dispatch."aggregateId" = event."sessionId"
        AND terminal_dispatch."idempotencyKey" = ('agent-event:' || event."id")
        AND terminal_dispatch."payload" = jsonb_build_object('eventId', event."id", 'sessionId', event."sessionId",
          'turnId', event."turnId", 'taskId', event."taskId", 'itemId', event."itemId", 'sequence', event."sequence"::text,
          'type', event."type", 'actor', event."actor", 'correlationId', event."correlationId",
          'causationId', event."causationId", 'idempotencyKey', event."idempotencyKey", 'payload', event.payload)
      JOIN "agent_events" AS witness ON witness."sessionId" = event."sessionId" AND witness."turnId" = event."turnId"
        AND witness."taskId" = event."taskId" AND witness."itemId" IS NULL
        AND witness."type" = 'agent.plan.root_task_history_chronology_witness' AND witness."actor" = 'orchestrator'
        AND witness."correlationId" = event."taskId" AND witness."causationId" = event."id"
        AND witness."idempotencyKey" = ('root-task-history-chronology-witness:root_terminal:' || event."id" || ':v1')
        AND witness.payload = jsonb_build_object('schemaVersion', 'agent-harness.v2.root-task-history-chronology-witness.v1',
          'boundary', 'root_terminal', 'boundaryEventId', event."id", 'xid8', witness.payload->>'xid8')
        AND jsonb_typeof(witness.payload->'xid8') = 'string'
        AND witness.payload->>'xid8' ~ '^[1-9][0-9]{0,19}$'
        AND (witness.payload->>'xid8')::numeric <= 18446744073709551615
      JOIN "agent_outbox" AS dispatch ON dispatch."id" = ('agent-outbox-' || witness."id")
        AND dispatch."topic" = 'agent.events' AND dispatch."aggregateId" = witness."sessionId"
        AND dispatch."idempotencyKey" = ('agent-event:' || witness."id")
        AND dispatch."payload" = jsonb_build_object('eventId', witness."id", 'sessionId', witness."sessionId",
          'turnId', witness."turnId", 'taskId', witness."taskId", 'itemId', NULL, 'sequence', witness."sequence"::text,
          'type', witness."type", 'actor', witness."actor", 'correlationId', witness."correlationId",
          'causationId', witness."causationId", 'idempotencyKey', witness."idempotencyKey", 'payload', witness.payload)
      WHERE event."sessionId" <> $1 AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')
        AND event."taskId" = turn."rootTaskId" AND turn."userId" = $2
        AND turn."status" IN ('completed', 'failed', 'interrupted') AND task."status" = turn."status"
        AND task."parentTaskId" IS NULL AND task."role" = 'orchestrator' AND task."taskType" = 'root'
        AND event."type" = CASE turn."status" WHEN 'completed' THEN 'turn.completed'
          WHEN 'failed' THEN 'turn.failed' WHEN 'interrupted' THEN 'turn.interrupted' END
        AND NOT (turn."input" ? 'selectedJobPreparation')
        AND (NOT (turn."input" ? 'input') OR (jsonb_typeof(turn."input"->'input') = 'object'
          AND NOT ((turn."input"->'input') ? 'selectedJobPreparation')))
        AND (witness.payload->>'xid8')::numeric < $4::numeric
        AND turn."objectiveDigest" = $6 AND turn."objectiveIndexSemanticsVersion" = $7
        AND ${origin} AND ${compatibility}
      ORDER BY (witness.payload->>'xid8')::numeric DESC, event."turnId" DESC
      LIMIT $9`,
    values: [input.currentSessionId, input.userId, input.currentTurnId, input.currentStartXid8,
      input.scheduledCriteria, input.objectiveDigest, input.semanticsVersion, input.canonicalOrigin, input.limit],
  }
}
