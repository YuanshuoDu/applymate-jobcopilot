import { Type, type Static } from '@sinclair/typebox'
import { IdSchema, JsonValueSchema, NonEmptyTextSchema, SchemaVersionSchema, TimestampSchema } from './common.js'

export const ApprovalTypeSchema = Type.Union([
  Type.Literal('submit_application'),
  Type.Literal('send_gmail'),
  Type.Literal('resume_upload'),
  Type.Literal('automation_mutation'),
  Type.Literal('sensitive_answer'),
  // Legacy approval labels remain valid while their call sites migrate to
  // typed policy receipts in AH2-021.
  Type.Literal('apply_jobs'),
  Type.Literal('tailor_resume'),
  Type.Literal('confirm_tailored_resume'),
  Type.Literal('review_application'),
])

export const ApprovalStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('approved'),
  Type.Literal('rejected'),
  Type.Literal('expired'),
  Type.Literal('consumed'),
])

export const ApprovalHashSchema = Type.String({ pattern: '^(?:[a-f0-9]{64}|sha256:[a-f0-9]{64})$' })

/** Approval hashes accept the legacy bare digest and the artifact digest form. */
export function isApprovalHash(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(value)
}

export const ApprovalScopeSchema = Type.Object({
  userId: IdSchema,
  sessionId: IdSchema,
  turnId: IdSchema,
  jobId: IdSchema,
  toolCallId: IdSchema,
  action: ApprovalTypeSchema,
  // resourceHash is the canonical hash of the exact target/resource.
  resourceHash: ApprovalHashSchema,
  materialHash: ApprovalHashSchema,
  answersHash: ApprovalHashSchema,
  revision: Type.Integer({ minimum: 0 }),
  nonceHash: ApprovalHashSchema,
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
  scopeHash: ApprovalHashSchema,
  payload: JsonValueSchema,
  decidedAt: Type.Union([TimestampSchema, Type.Null()]),
  consumedAt: Type.Union([TimestampSchema, Type.Null()]),
  createdAt: TimestampSchema,
}, { $id: 'agent.approval', additionalProperties: false })

export type ApprovalType = Static<typeof ApprovalTypeSchema>
export type ApprovalStatus = Static<typeof ApprovalStatusSchema>
export type ApprovalScope = Static<typeof ApprovalScopeSchema>
export type AgentApproval = Static<typeof AgentApprovalSchema>

/**
 * Stable, versioned preimage used by both the Web Prisma store and Worker PG
 * store. Keep the field order explicit: changing it is a protocol migration.
 */
export function serializeApprovalScope(scope: ApprovalScope): string {
  return JSON.stringify({
    version: 1,
    userId: scope.userId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    jobId: scope.jobId,
    toolCallId: scope.toolCallId,
    action: scope.action,
    resourceHash: scope.resourceHash,
    materialHash: scope.materialHash,
    answersHash: scope.answersHash,
    revision: scope.revision,
    nonceHash: scope.nonceHash,
    expiresAt: scope.expiresAt,
  })
}
