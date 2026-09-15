import { Type, type Static } from '@sinclair/typebox'
import { ActorSchema, IdSchema, JsonValueSchema, NullableIdSchema, SchemaVersionSchema, SequenceSchema, TimestampSchema } from './common.js'

export const AgentEventTypeSchema = Type.Union([
  Type.Literal('turn.started'),
  Type.Literal('turn.wakeup'),
  Type.Literal('turn.resumed'),
  Type.Literal('turn.completed'),
  Type.Literal('turn.failed'),
  Type.Literal('step.started'),
  Type.Literal('step.completed'),
  Type.Literal('item.started'),
  Type.Literal('item.delta'),
  Type.Literal('item.completed'),
  Type.Literal('item.failed'),
  Type.Literal('input.accepted'),
  Type.Literal('input.consumed'),
  Type.Literal('tool_call.started'),
  Type.Literal('tool_call.completed'),
  Type.Literal('tool_call.failed'),
  Type.Literal('plan.observation'),
  Type.Literal('plan.revision'),
  Type.Literal('plan.command'),
  Type.Literal('goal.revision'),
  Type.Literal('policy.decision'),
  Type.Literal('approval.requested'),
  Type.Literal('approval.resolved'),
  Type.Literal('approval.consumed'),
  Type.Literal('approval.expired'),
  Type.Literal('question.answered'),
  Type.Literal('question.cancelled'),
  Type.Literal('external_action.reserved'),
  Type.Literal('session.paused'),
  Type.Literal('session.resumed'),
])

export const SessionControlEventTypeSchema = Type.Union([
  Type.Literal('session.paused'),
  Type.Literal('session.resumed'),
])

export const SessionControlEventPayloadSchema = Type.Union([
  Type.Object({
    sessionId: IdSchema,
    operation: Type.Literal('pause'),
    previousGate: Type.Literal('open'),
    nextGate: Type.Literal('user_paused'),
    controlRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    pausedAt: TimestampSchema,
  }, { additionalProperties: false }),
  Type.Object({
    sessionId: IdSchema,
    operation: Type.Literal('resume'),
    previousGate: Type.Literal('user_paused'),
    nextGate: Type.Literal('open'),
    controlRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    pausedAt: Type.Null(),
  }, { additionalProperties: false }),
])

const eventEnvelopeFields = {
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  sessionId: IdSchema,
  sequence: SequenceSchema,
  correlationId: IdSchema,
  causationId: NullableIdSchema,
  idempotencyKey: NullableIdSchema,
  createdAt: TimestampSchema,
} as const

const turnScopedEventTypeSchema = Type.Intersect([
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.Not(SessionControlEventTypeSchema),
])

const sessionControlEventEnvelope = Type.Object({
  ...eventEnvelopeFields,
  type: SessionControlEventTypeSchema,
  idempotencyKey: IdSchema,
  turnId: Type.Null(),
  itemId: Type.Null(),
  taskId: Type.Null(),
  actor: Type.Literal('system'),
  payload: SessionControlEventPayloadSchema,
}, { additionalProperties: false })

const turnScopedEventEnvelope = Type.Object({
  ...eventEnvelopeFields,
  type: turnScopedEventTypeSchema,
  turnId: IdSchema,
  itemId: NullableIdSchema,
  taskId: NullableIdSchema,
  actor: ActorSchema,
  payload: JsonValueSchema,
}, { additionalProperties: false })

const knownTurnScopedEventEnvelope = Type.Object({
  ...eventEnvelopeFields,
  type: Type.Exclude(AgentEventTypeSchema, SessionControlEventTypeSchema),
  turnId: IdSchema,
  itemId: NullableIdSchema,
  taskId: NullableIdSchema,
  actor: ActorSchema,
  payload: JsonValueSchema,
}, { additionalProperties: false })

export const AgentEventEnvelopeSchema = Type.Union([
  sessionControlEventEnvelope,
  turnScopedEventEnvelope,
], { $id: 'agent.event.envelope' })

export const KnownAgentEventEnvelopeSchema = Type.Union([
  sessionControlEventEnvelope,
  knownTurnScopedEventEnvelope,
], { $id: 'agent.event.known' })

export type AgentEventType = Static<typeof AgentEventTypeSchema>
export type SessionControlEventType = Static<typeof SessionControlEventTypeSchema>
export type SessionControlEventPayload = Static<typeof SessionControlEventPayloadSchema>
type AgentEventEnvelopeBase = Static<typeof AgentEventEnvelopeSchema>
type KnownAgentEventEnvelopeBase = Static<typeof KnownAgentEventEnvelopeSchema>
export type AgentEventEnvelope<TPayload = unknown> = Omit<AgentEventEnvelopeBase, 'payload'> & { payload: TPayload }
export type KnownAgentEventEnvelope<TPayload = unknown> = Omit<KnownAgentEventEnvelopeBase, 'payload'> & { payload: TPayload }

export function isKnownAgentEventType(value: string): value is AgentEventType {
  return AgentEventTypeSchema.anyOf?.some((candidate) => candidate.const === value) ?? false
}
