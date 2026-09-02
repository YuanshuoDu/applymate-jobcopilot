import { Type, type Static } from '@sinclair/typebox'
import { IdSchema, NonEmptyTextSchema, SchemaVersionSchema } from './common.js'
import { InputContentPartSchema } from './input.js'

export const ModelToolUsePartSchema = Type.Object({
  type: Type.Literal('tool_use'),
  id: IdSchema,
  name: IdSchema,
  input: Type.Unknown(),
}, { additionalProperties: false })

export const ModelToolResultPartSchema = Type.Object({
  type: Type.Literal('tool_result'),
  toolUseId: IdSchema,
  content: NonEmptyTextSchema,
  isError: Type.Optional(Type.Boolean()),
}, { additionalProperties: false })

export const ModelContentPartSchema = Type.Union([
  InputContentPartSchema,
  ModelToolUsePartSchema,
  ModelToolResultPartSchema,
])

export const ModelRoleSchema = Type.Union([
  Type.Literal('system'),
  Type.Literal('user'),
  Type.Literal('assistant'),
  Type.Literal('tool'),
])

export const ModelMessageSchema = Type.Object({
  role: ModelRoleSchema,
  content: Type.Array(ModelContentPartSchema, { minItems: 1 }),
}, { additionalProperties: false })

export const ModelCapabilitiesSchema = Type.Object({
  nativeTools: Type.Boolean(),
  structuredOutput: Type.Boolean(),
  streaming: Type.Boolean(),
  continuationCursor: Type.Boolean(),
}, { additionalProperties: false })

export const ModelToolCallSchema = Type.Object({
  id: IdSchema,
  name: IdSchema,
  arguments: Type.Unknown(),
}, { additionalProperties: false })

export const ModelUsageSchema = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  estimatedCostUsd: Type.Number({ minimum: 0 }),
}, { additionalProperties: false })

export const ModelRequestSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  provider: IdSchema,
  model: IdSchema,
  messages: Type.Array(ModelMessageSchema, { minItems: 1 }),
  tools: Type.Array(Type.Unknown()),
  capabilities: ModelCapabilitiesSchema,
}, { $id: 'agent.model.request', additionalProperties: false })

export const ModelResponseSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  provider: IdSchema,
  model: IdSchema,
  finishReason: Type.Union([
    Type.Literal('stop'),
    Type.Literal('tool_calls'),
    Type.Literal('length'),
    Type.Literal('content_filter'),
    Type.Literal('error'),
  ]),
  text: Type.Optional(Type.String()),
  toolCalls: Type.Array(ModelToolCallSchema),
  usage: Type.Union([ModelUsageSchema, Type.Null()]),
  continuationCursor: Type.Union([NonEmptyTextSchema, Type.Null()]),
}, { $id: 'agent.model.response', additionalProperties: false })

export type ModelRole = Static<typeof ModelRoleSchema>
export type ModelToolUsePart = Static<typeof ModelToolUsePartSchema>
export type ModelToolResultPart = Static<typeof ModelToolResultPartSchema>
export type ModelContentPart = Static<typeof ModelContentPartSchema>
export type ModelMessage = Static<typeof ModelMessageSchema>
export type ModelCapabilities = Static<typeof ModelCapabilitiesSchema>
export type ModelToolCall = Static<typeof ModelToolCallSchema>
export type ModelUsage = Static<typeof ModelUsageSchema>
export type ModelRequest = Static<typeof ModelRequestSchema>
export type ModelResponse = Static<typeof ModelResponseSchema>
