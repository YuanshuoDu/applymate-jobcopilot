import { Type, type Static } from '@sinclair/typebox'
import { IdSchema, NonEmptyTextSchema, NullableIdSchema, SchemaVersionSchema, TimestampSchema } from './common.js'

export const TextPartSchema = Type.Object({
  type: Type.Literal('text'),
  text: NonEmptyTextSchema,
}, { additionalProperties: false })

export const AttachmentRefPartSchema = Type.Object({
  type: Type.Literal('attachment_ref'),
  attachmentId: IdSchema,
  mediaType: IdSchema,
  filename: Type.Optional(IdSchema),
}, { additionalProperties: false })

export const InputContentPartSchema = Type.Union([TextPartSchema, AttachmentRefPartSchema])
export const AgentInputDeliverySchema = Type.Union([Type.Literal('steer'), Type.Literal('follow_up')])
export const AgentInputStateSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('queued'),
  Type.Literal('consumed'),
  Type.Literal('cancelled'),
  Type.Literal('rejected'),
])

export const AgentInputCommandSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  clientMessageId: IdSchema,
  sessionId: IdSchema,
  expectedTurnId: NullableIdSchema,
  delivery: AgentInputDeliverySchema,
  content: Type.Array(InputContentPartSchema, { minItems: 1 }),
}, { $id: 'agent.input.command', additionalProperties: false })

export const AgentInputSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  clientMessageId: IdSchema,
  sessionId: IdSchema,
  turnId: NullableIdSchema,
  delivery: AgentInputDeliverySchema,
  state: AgentInputStateSchema,
  content: Type.Array(InputContentPartSchema, { minItems: 1 }),
  createdAt: TimestampSchema,
  consumedAt: Type.Union([TimestampSchema, Type.Null()]),
}, { $id: 'agent.input', additionalProperties: false })

export type TextPart = Static<typeof TextPartSchema>
export type AttachmentRefPart = Static<typeof AttachmentRefPartSchema>
export type InputContentPart = Static<typeof InputContentPartSchema>
export type AgentInputDelivery = Static<typeof AgentInputDeliverySchema>
export type AgentInputState = Static<typeof AgentInputStateSchema>
export type AgentInputCommand = Static<typeof AgentInputCommandSchema>
export type AgentInput = Static<typeof AgentInputSchema>
