import { Type, type Static } from '@sinclair/typebox'
import { IdSchema, JsonValueSchema, NonEmptyTextSchema, SchemaVersionSchema, TimestampSchema } from './common.js'

export const ApprovalTypeSchema = Type.Union([
  Type.Literal('submit_application'),
  Type.Literal('send_gmail'),
  Type.Literal('resume_upload'),
  Type.Literal('automation_mutation'),
  Type.Literal('sensitive_answer'),
])

export const ApprovalStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('approved'),
  Type.Literal('rejected'),
  Type.Literal('expired'),
  Type.Literal('consumed'),
])

export const ApprovalScopeSchema = Type.Object({
  userId: IdSchema,
  sessionId: IdSchema,
  turnId: IdSchema,
  toolCallId: IdSchema,
  action: ApprovalTypeSchema,
  resourceHash: IdSchema,
  expiresAt: TimestampSchema,
}, { additionalProperties: false })

export const AgentApprovalSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  type: ApprovalTypeSchema,
  status: ApprovalStatusSchema,
  title: NonEmptyTextSchema,
  body: NonEmptyTextSchema,
  scope: ApprovalScopeSchema,
  payload: JsonValueSchema,
  decidedAt: Type.Union([TimestampSchema, Type.Null()]),
  createdAt: TimestampSchema,
}, { $id: 'agent.approval', additionalProperties: false })

export type ApprovalType = Static<typeof ApprovalTypeSchema>
export type ApprovalStatus = Static<typeof ApprovalStatusSchema>
export type ApprovalScope = Static<typeof ApprovalScopeSchema>
export type AgentApproval = Static<typeof AgentApprovalSchema>
