import { db } from '@/lib/db'

export type HarnessDashboardKind = 'queue' | 'agents' | 'sse' | 'usage'

export type HarnessUsageRow = {
  model: string
  toolName: string
  eventCount: number
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
}

export type HarnessDashboardSnapshot = {
  available: boolean
  kind: HarnessDashboardKind
  windowMinutes: number
  eventCount: number | null
  latestEventAt: string | null
  latestQueueDepth: number | null
  failedEventCount: number | null
  startedSessions: number | null
  completedSessions: number | null
  activeTurns: number | null
  usage: HarnessUsageRow[]
  openAlerts: Array<{ ruleKey: string; metric: string; value: number; threshold: number; createdAt: string }>
}

const WINDOW_MINUTES = 24 * 60

function unavailable(kind: HarnessDashboardKind): HarnessDashboardSnapshot {
  return {
    available: false,
    kind,
    windowMinutes: WINDOW_MINUTES,
    eventCount: null,
    latestEventAt: null,
    latestQueueDepth: null,
    failedEventCount: null,
    startedSessions: null,
    completedSessions: null,
    activeTurns: null,
    usage: [],
    openAlerts: [],
  }
}

function iso(value: Date | null | undefined) {
  return value instanceof Date ? value.toISOString() : null
}

/** Read-only admin aggregate; raw event payloads and error details never leave the server. */
export async function getHarnessDashboardSnapshot(kind: HarnessDashboardKind): Promise<HarnessDashboardSnapshot> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000)
  try {
    const [summary, queue, lifecycle, usage, alerts] = await Promise.all([
      db.$queryRaw<Array<{ event_count: number; latest_event_at: Date | null; failed_event_count: number }>>`
        SELECT COUNT(*)::int AS event_count,
          MAX("occurred_at") AS latest_event_at,
          COUNT(*) FILTER (WHERE "event_type" IN ('turn.failed', 'tool.failed', 'submission.failed'))::int AS failed_event_count
        FROM "harness_metric_events"
        WHERE "occurred_at" >= ${since}
      `,
      db.$queryRaw<Array<{ value: number | null }>>`
        SELECT "value" FROM "harness_metric_events"
        WHERE "event_type" = 'queue.depth' AND "occurred_at" >= ${since}
        ORDER BY "occurred_at" DESC LIMIT 1
      `,
      db.$queryRaw<Array<{ started_sessions: number; completed_sessions: number; active_turns: number }>>`
        SELECT
          COUNT(*) FILTER (WHERE "event_type" = 'session.started')::int AS started_sessions,
          COUNT(*) FILTER (WHERE "event_type" = 'session.completed')::int AS completed_sessions,
          COUNT(*) FILTER (WHERE "event_type" IN ('turn.queued', 'turn.started'))::int -
            COUNT(*) FILTER (WHERE "event_type" IN ('turn.completed', 'turn.failed'))::int AS active_turns
        FROM "harness_metric_events"
        WHERE "occurred_at" >= ${since}
      `,
      db.$queryRaw<Array<{ model: string; tool_name: string | null; event_count: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number }>>`
        SELECT "model", COALESCE("tool_name", '(none)') AS tool_name,
          SUM("event_count")::int AS event_count,
          SUM("input_tokens")::int AS input_tokens,
          SUM("output_tokens")::int AS output_tokens,
          SUM("estimated_cost_usd")::float AS estimated_cost_usd
        FROM "usage_event"
        WHERE "bucket_start" >= ${since}
        GROUP BY "model", "tool_name"
        ORDER BY estimated_cost_usd DESC, "model", tool_name
        LIMIT 50
      `,
      db.$queryRaw<Array<{ rule_key: string; metric: string; value: number; threshold: number; created_at: Date }>>`
        SELECT "rule_key", "metric", "value", "threshold", "created_at"
        FROM "harness_slo_alerts"
        WHERE "status" = 'open'
        ORDER BY "created_at" DESC LIMIT 20
      `,
    ])
    const row = summary[0]
    const life = lifecycle[0]
    return {
      available: true,
      kind,
      windowMinutes: WINDOW_MINUTES,
      eventCount: Number(row?.event_count ?? 0),
      latestEventAt: iso(row?.latest_event_at),
      latestQueueDepth: queue[0]?.value == null ? null : Number(queue[0].value),
      failedEventCount: Number(row?.failed_event_count ?? 0),
      startedSessions: Number(life?.started_sessions ?? 0),
      completedSessions: Number(life?.completed_sessions ?? 0),
      activeTurns: Math.max(Number(life?.active_turns ?? 0), 0),
      usage: usage.map(item => ({
        model: item.model,
        toolName: item.tool_name ?? '(none)',
        eventCount: Number(item.event_count ?? 0),
        inputTokens: Number(item.input_tokens ?? 0),
        outputTokens: Number(item.output_tokens ?? 0),
        estimatedCostUsd: Number(item.estimated_cost_usd ?? 0),
      })),
      openAlerts: alerts.map(item => ({
        ruleKey: item.rule_key,
        metric: item.metric,
        value: Number(item.value),
        threshold: Number(item.threshold),
        createdAt: item.created_at.toISOString(),
      })),
    }
  } catch {
    console.error(JSON.stringify({ level: 'error', msg: 'harness_observability_read_failed', kind }))
    return unavailable(kind)
  }
}
