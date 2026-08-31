import { Type, type Static } from '@sinclair/typebox'
import { IdSchema, JsonValueSchema, NonEmptyTextSchema, NullableIdSchema, SchemaVersionSchema, TimestampSchema } from './common.js'

export const ItemStatusSchema = Type.Union([
  Type.Literal('started'),
  Type.Literal('streaming'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('interrupted'),
])

export const AgentMessagePhaseSchema = Type.Union([Type.Literal('commentary'), Type.Literal('final_answer')])
const ItemBase = {
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  sessionId: IdSchema,
  turnId: IdSchema,
  stepId: NullableIdSchema,
  status: ItemStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}

export const AgentMessageItemSchema = Type.Object({
  ...ItemBase,
  type: Type.Literal('agent_message'),
  phase: AgentMessagePhaseSchema,
  text: Type.String(),
}, { additionalProperties: false })

export const ToolCallItemSchema = Type.Object({
  ...ItemBase,
  type: Type.Literal('tool_call'),
  toolCallId: IdSchema,
  toolName: IdSchema,
  input: JsonValueSchema,
}, { additionalProperties: false })

export const ToolResultItemSchema = Type.Object({
  ...ItemBase,
  type: Type.Literal('tool_result'),
  toolCallId: IdSchema,
  output: JsonValueSchema,
  errorCode: Type.Union([IdSchema, Type.Null()]),
}, { additionalProperties: false })

export const GenericItemTypeSchema = Type.Union([
  Type.Literal('user_message'),
  Type.Literal('plan'),
  Type.Literal('reasoning_summary'),
  Type.Literal('subagent_activity'),
  Type.Literal('approval_request'),
  Type.Literal('approval_response'),
  Type.Literal('question'),
  Type.Literal('artifact'),
  Type.Literal('context_compaction'),
  Type.Literal('error'),
])

export const GenericItemSchema = Type.Object({
  ...ItemBase,
  type: GenericItemTypeSchema,
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  data: Type.Optional(JsonValueSchema),
}, { additionalProperties: false })

export const AgentItemSchema = Type.Union([
  AgentMessageItemSchema,
  ToolCallItemSchema,
  ToolResultItemSchema,
  GenericItemSchema,
], { $id: 'agent.item' })

export type ItemStatus = Static<typeof ItemStatusSchema>
export type AgentMessagePhase = Static<typeof AgentMessagePhaseSchema>
export type AgentMessageItem = Static<typeof AgentMessageItemSchema>
export type ToolCallItem = Static<typeof ToolCallItemSchema>
export type ToolResultItem = Static<typeof ToolResultItemSchema>
export type GenericItem = Static<typeof GenericItemSchema>
export type AgentItem = Static<typeof AgentItemSchema>
