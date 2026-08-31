import { Type, type Static } from '@sinclair/typebox'
import { IdSchema, NonEmptyTextSchema, NullableIdSchema, SchemaVersionSchema, TimestampSchema } from './common.js'

export const TurnStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('in_progress'),
  Type.Literal('waiting_for_dependency'),
  Type.Literal('waiting_for_approval'),
  Type.Literal('waiting_for_user'),
  Type.Literal('interrupted'),
  Type.Literal('cancelled'),
  Type.Literal('failed'),
  Type.Literal('completed'),
])

export const TurnSourceSchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('automation'),
  Type.Literal('system'),
])

export const AgentTurnSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  sessionId: IdSchema,
  source: TurnSourceSchema,
  goal: NonEmptyTextSchema,
  status: TurnStatusSchema,
  activeStepId: NullableIdSchema,
  finalItemId: NullableIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: Type.Union([TimestampSchema, Type.Null()]),
}, { $id: 'agent.turn', additionalProperties: false })

export type TurnStatus = Static<typeof TurnStatusSchema>
export type TurnSource = Static<typeof TurnSourceSchema>
export type AgentTurn = Static<typeof AgentTurnSchema>
