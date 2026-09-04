export const USAGE_AGGREGATION_INTERVAL_MS = 5 * 60 * 1_000

export interface UsageEventRecord {
  userId: string
  model: string
  toolName: string | null
  sessionId: string
  turnId: string | null
  traceId: string
  inputTokens: number
  outputTokens: number
  costMicros: number
  occurredAt: Date | string
}

export interface UsageQueryWindow {
  from: Date
  to: Date
  userId?: string
}

export interface UsageEventReader {
  read(window: UsageQueryWindow): Promise<readonly UsageEventRecord[]>
}

export interface UsageAggregate {
  userId: string
  model: string
  toolName: string | null
  day: string
  eventCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costMicros: number
  sessionCount: number
  turnCount: number
  traceCount: number
  /** Session/turn/trace rows keep the cost path queryable below the daily bucket. */
  lineage: readonly UsageLineage[]
}

export interface UsageLineage {
  sessionId: string
  turnId: string | null
  traceId: string
  eventCount: number
  inputTokens: number
  outputTokens: number
  costMicros: number
}

export interface UsageAggregationOptions {
  now?: Date
  from?: Date
  to?: Date
  userId?: string
}

function asDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`)
  return date
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`)
  return value
}

function opaqueId(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256 || /\s/u.test(value) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value)) {
    throw new Error(`${label} must be an opaque non-PII identifier`)
  }
  return value
}

function utcDay(value: Date | string): string {
  return asDate(value, "occurredAt").toISOString().slice(0, 10)
}

function defaultWindow(options: UsageAggregationOptions): UsageQueryWindow {
  const to = asDate(options.to ?? options.now ?? new Date(), "to")
  const from = asDate(options.from ?? new Date(to.getTime() - USAGE_AGGREGATION_INTERVAL_MS), "from")
  if (from > to) throw new Error("usage window from must be before to")
  return { from, to, ...(options.userId ? { userId: options.userId } : {}) }
}

/** Aggregates only the typed, non-content usage fields; unknown/P-II keys cannot leak into output. */
export function aggregateUsage(records: readonly UsageEventRecord[]): UsageAggregate[] {
  const buckets = new Map<string, UsageAggregate & { sessions: Set<string>; turns: Set<string>; traces: Set<string>; lineageByKey: Map<string, UsageLineage> }>()
  for (const record of records) {
    const userId = opaqueId(record.userId, "userId")
    const model = String(record.model)
    if (!model.trim() || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) throw new Error("model must be a bounded string")
    const inputTokens = nonNegative(record.inputTokens, "inputTokens")
    const outputTokens = nonNegative(record.outputTokens, "outputTokens")
    const costMicros = nonNegative(record.costMicros, "costMicros")
    const day = utcDay(record.occurredAt)
    const toolName = record.toolName === null ? null : String(record.toolName)
    if (toolName !== null && (!toolName.trim() || toolName.length > 256 || /[\u0000-\u001f\u007f]/u.test(toolName))) throw new Error("toolName must be a bounded string")
    const key = JSON.stringify([userId, model, toolName, day])
    const bucket = buckets.get(key) ?? {
      userId, model, toolName, day, eventCount: 0, inputTokens: 0, outputTokens: 0,
      totalTokens: 0, costMicros: 0, sessionCount: 0, turnCount: 0, traceCount: 0,
      lineage: [], sessions: new Set<string>(), turns: new Set<string>(), traces: new Set<string>(), lineageByKey: new Map(),
    }
    bucket.eventCount += 1
    bucket.inputTokens += inputTokens
    bucket.outputTokens += outputTokens
    bucket.totalTokens += inputTokens + outputTokens
    bucket.costMicros += costMicros
    bucket.sessions.add(record.sessionId)
    if (record.turnId) bucket.turns.add(record.turnId)
    bucket.traces.add(record.traceId)
    const lineageKey = JSON.stringify([record.sessionId, record.turnId, record.traceId])
    const lineage = bucket.lineageByKey.get(lineageKey) ?? {
      sessionId: record.sessionId, turnId: record.turnId, traceId: record.traceId,
      eventCount: 0, inputTokens: 0, outputTokens: 0, costMicros: 0,
    }
    lineage.eventCount += 1
    lineage.inputTokens += inputTokens
    lineage.outputTokens += outputTokens
    lineage.costMicros += costMicros
    bucket.lineageByKey.set(lineageKey, lineage)
    bucket.lineage = [...bucket.lineageByKey.values()]
    bucket.sessionCount = bucket.sessions.size
    bucket.turnCount = bucket.turns.size
    bucket.traceCount = bucket.traces.size
    buckets.set(key, bucket)
  }
  return [...buckets.values()].map(({ sessions: _sessions, turns: _turns, traces: _traces, lineageByKey: _lineageByKey, ...aggregate }) => aggregate)
}

export async function queryUsage(reader: UsageEventReader, options: UsageAggregationOptions = {}): Promise<UsageAggregate[]> {
  return aggregateUsage(await reader.read(defaultWindow(options)))
}
