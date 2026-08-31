import { Type, type Static } from '@sinclair/typebox'
import { IdSchema, NullableIdSchema, SchemaVersionSchema, SequenceSchema, TimestampSchema } from './common.js'

export const StepStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('streaming'),
  Type.Literal('waiting_for_tool'),
  Type.Literal('waiting_for_approval'),
  Type.Literal('waiting_for_user'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('interrupted'),
])

export const AgentStepUsageSchema = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  estimatedCostUsd: Type.Number({ minimum: 0 }),
}, { additionalProperties: false })

export const AgentStepSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  turnId: IdSchema,
  parentStepId: NullableIdSchema,
  ordinal: Type.Integer({ minimum: 0 }),
  attempt: Type.Integer({ minimum: 1 }),
  status: StepStatusSchema,
  inputSnapshotId: NullableIdSchema,
  inputThroughSequence: Type.Union([SequenceSchema, Type.Null()]),
  consumedInputIds: Type.Array(IdSchema),
  provider: IdSchema,
  model: IdSchema,
  toolCallIds: Type.Array(IdSchema),
  finishReason: Type.Union([IdSchema, Type.Null()]),
  usage: Type.Union([AgentStepUsageSchema, Type.Null()]),
  errorCode: Type.Union([IdSchema, Type.Null()]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}, { $id: 'agent.step', additionalProperties: false })

export type StepStatus = Static<typeof StepStatusSchema>
export type AgentStepUsage = Static<typeof AgentStepUsageSchema>
export type AgentStep = Static<typeof AgentStepSchema>
