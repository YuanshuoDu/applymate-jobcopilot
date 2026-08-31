import { Type, type Static } from '@sinclair/typebox'
import { IdSchema, JsonValueSchema, NonEmptyTextSchema, SchemaVersionSchema, TimestampSchema } from './common.js'

export const ToolCapabilitySchema = Type.Union([
  Type.Literal('read'),
  Type.Literal('write'),
  Type.Literal('external_write'),
  Type.Literal('coordination'),
  Type.Literal('browser'),
])

export const ToolCallStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
])

export const ToolRiskSchema = Type.Union([
  Type.Literal('read'),
  Type.Literal('draft_write'),
  Type.Literal('internal_write'),
  Type.Literal('external_write'),
])

export const ToolDefinitionSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  name: IdSchema,
  version: IdSchema,
  description: NonEmptyTextSchema,
  capabilities: Type.Array(ToolCapabilitySchema, { minItems: 1 }),
  inputSchema: JsonValueSchema,
  outputSchema: JsonValueSchema,
}, { $id: 'agent.tool.definition', additionalProperties: false })

export const ToolCallSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  turnId: IdSchema,
  stepId: IdSchema,
  toolName: IdSchema,
  toolVersion: IdSchema,
  status: ToolCallStatusSchema,
  input: JsonValueSchema,
  output: Type.Optional(JsonValueSchema),
  errorCode: Type.Union([IdSchema, Type.Null()]),
  createdAt: TimestampSchema,
  completedAt: Type.Union([TimestampSchema, Type.Null()]),
}, { $id: 'agent.tool.call', additionalProperties: false })

export type ToolCapability = Static<typeof ToolCapabilitySchema>
export type ToolCallStatus = Static<typeof ToolCallStatusSchema>
export type ToolRisk = Static<typeof ToolRiskSchema>
export type ToolDefinition = Static<typeof ToolDefinitionSchema>
export type ToolCall = Static<typeof ToolCallSchema>
