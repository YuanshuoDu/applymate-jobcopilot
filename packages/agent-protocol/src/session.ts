import { Type, type Static } from '@sinclair/typebox'
import { IdSchema, NonEmptyTextSchema, NullableIdSchema, SchemaVersionSchema, TimestampSchema } from './common.js'

export const SessionStatusSchema = Type.Union([
  Type.Literal('idle'),
  Type.Literal('running'),
  Type.Literal('waiting_for_user'),
  Type.Literal('paused'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('archived'),
])

export const SessionSourceSchema = Type.Union([
  Type.Literal('chat'),
  Type.Literal('manual'),
  Type.Literal('automation'),
  Type.Literal('system'),
])

export const AgentSessionSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  userId: IdSchema,
  goal: NonEmptyTextSchema,
  status: SessionStatusSchema,
  source: SessionSourceSchema,
  activeRootTurnId: NullableIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}, { $id: 'agent.session', additionalProperties: false })

export type SessionStatus = Static<typeof SessionStatusSchema>
export type SessionSource = Static<typeof SessionSourceSchema>
export type AgentSession = Static<typeof AgentSessionSchema>
