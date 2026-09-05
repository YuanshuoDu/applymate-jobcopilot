import { aggregateUsage, type UsageEventRecord } from '../src/lib/observability/usage-aggregator'
import { createHarnessEvent } from '../src/lib/observability/event-types'

const trace = { traceId: 'synthetic-trace', spanId: 'synthetic-session', parentSpanId: null }
const common = { sessionId: 'synthetic-session', userId: 'synthetic-user', occurredAt: '2026-01-01T00:00:00.000Z' }

const events = [
  createHarnessEvent({ ...common, eventType: 'session.started', trace, eventId: 'synthetic-1', payload: { entryPoint: 'ci', harnessVersion: '2.0' } }),
  createHarnessEvent({ ...common, eventType: 'turn.started', trace: { ...trace, spanId: 'synthetic-turn', parentSpanId: 'synthetic-session' }, turnId: 'synthetic-turn', eventId: 'synthetic-2', payload: { turnIndex: 0, mode: 'normal' } }),
  createHarnessEvent({ ...common, eventType: 'tool.invoked', trace: { ...trace, spanId: 'synthetic-tool', parentSpanId: 'synthetic-turn' }, turnId: 'synthetic-turn', toolName: 'jobs.search', eventId: 'synthetic-3', payload: { toolName: 'jobs.search', toolVersion: '1', approvalRequired: false } }),
  createHarnessEvent({ ...common, eventType: 'submission.completed', trace: { ...trace, spanId: 'synthetic-submit', parentSpanId: 'synthetic-tool' }, turnId: 'synthetic-turn', toolName: 'browser.submit', eventId: 'synthetic-4', payload: { atsType: 'greenhouse', flowVersion: '1', durationMs: 120, resultCode: 'accepted' } }),
  createHarnessEvent({ ...common, eventType: 'cost.charged', trace: { ...trace, spanId: 'synthetic-cost', parentSpanId: 'synthetic-tool' }, turnId: 'synthetic-turn', toolName: 'jobs.search', model: 'MiniMax-M3', provider: 'minimax', eventId: 'synthetic-5', payload: { costMicros: 20, inputTokens: 10, outputTokens: 5, unit: 'request', chargeType: 'platform' } }),
]

if (events.length !== 5 || new Set(events.map((event) => event.eventId)).size !== 5) throw new Error('synthetic event emission did not produce five unique events')
const cost = events.find((event) => event.eventType === 'cost.charged')
if (!cost || !cost.model) throw new Error('synthetic cost event is missing model attribution')
const usage: UsageEventRecord[] = [{
  userId: common.userId, model: cost.model, toolName: cost.toolName ?? null, sessionId: common.sessionId,
  turnId: cost.turnId ?? null, traceId: cost.traceId, inputTokens: cost.payload.inputTokens ?? 0,
  outputTokens: cost.payload.outputTokens ?? 0, costMicros: cost.payload.costMicros ?? 0, occurredAt: cost.occurredAt,
}]
const aggregates = aggregateUsage(usage)
if (aggregates.length !== 1 || aggregates[0]?.costMicros !== 20) throw new Error(`unexpected synthetic usage result: ${JSON.stringify(aggregates)}`)
if (/email|text|ip|prompt|resume/i.test(JSON.stringify(events))) throw new Error('synthetic events contain a forbidden privacy token')

console.log(JSON.stringify({ status: 'passed', eventCount: events.length, aggregateCount: aggregates.length, costMicros: aggregates[0]?.costMicros }))
