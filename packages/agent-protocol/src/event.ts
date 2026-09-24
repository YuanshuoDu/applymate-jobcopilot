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
  Type.Literal('policy.decision'),
  Type.Literal('approval.requested'),
  Type.Literal('approval.resolved'),
  Type.Literal('approval.consumed'),
  Type.Literal('approval.expired'),
  Type.Literal('question.answered'),
  Type.Literal('question.cancelled'),
  Type.Literal('external_action.reserved'),
])

export const AgentEventEnvelopeSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  sessionId: IdSchema,
  turnId: IdSchema,
  itemId: NullableIdSchema,
  taskId: NullableIdSchema,
  sequence: SequenceSchema,
  type: Type.String({ minLength: 1, maxLength: 128 }),
  actor: ActorSchema,
  correlationId: IdSchema,
  causationId: NullableIdSchema,
  idempotencyKey: NullableIdSchema,
  payload: JsonValueSchema,
  createdAt: TimestampSchema,
}, { $id: 'agent.event.envelope', additionalProperties: false })

export const KnownAgentEventEnvelopeSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  sessionId: IdSchema,
  turnId: IdSchema,
  itemId: NullableIdSchema,
  taskId: NullableIdSchema,
  sequence: SequenceSchema,
  type: AgentEventTypeSchema,
  actor: ActorSchema,
  correlationId: IdSchema,
  causationId: NullableIdSchema,
  idempotencyKey: NullableIdSchema,
  payload: JsonValueSchema,
  createdAt: TimestampSchema,
}, { $id: 'agent.event.known', additionalProperties: false })

export type AgentEventType = Static<typeof AgentEventTypeSchema>
type AgentEventEnvelopeBase = Static<typeof AgentEventEnvelopeSchema>
type KnownAgentEventEnvelopeBase = Static<typeof KnownAgentEventEnvelopeSchema>
export type AgentEventEnvelope<TPayload = unknown> = Omit<AgentEventEnvelopeBase, 'payload'> & { payload: TPayload }
export type KnownAgentEventEnvelope<TPayload = unknown> = Omit<KnownAgentEventEnvelopeBase, 'payload'> & { payload: TPayload }

export function isKnownAgentEventType(value: string): value is AgentEventType {
  return AgentEventTypeSchema.anyOf?.some((candidate) => candidate.const === value) ?? false
}
