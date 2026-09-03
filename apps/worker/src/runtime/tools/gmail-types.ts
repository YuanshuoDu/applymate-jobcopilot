import { Type, type Static } from "@sinclair/typebox"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import type { ApprovalScopeMatch, ApprovalConsumeResult } from "../approval/types.js"
import type { ToolExecutionContext } from "./types.js"

const Id = Type.String({ minLength: 1, maxLength: 256 })
const Text = Type.String({ minLength: 1, maxLength: 50_000 })
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" })
const SafeHeader = Type.String({ minLength: 1, maxLength: 998, pattern: "^[^\\r\\n]+$" })

export const GmailGetThreadInputSchema = Type.Object({
  threadId: Type.Optional(Id),
  messageId: Type.Optional(Id),
}, { additionalProperties: false, minProperties: 1 })
export type GmailGetThreadInput = Static<typeof GmailGetThreadInputSchema>

export const GmailCreateDraftInputSchema = Type.Object({
  idempotencyKey: Id,
  jobId: Id,
  to: SafeHeader,
  subject: Type.String({ maxLength: 998, pattern: "^[^\\r\\n]*$" }),
  body: Text,
  threadId: Type.Optional(Id),
}, { additionalProperties: false })
export type GmailCreateDraftInput = Static<typeof GmailCreateDraftInputSchema>

export const GmailSendInputSchema = Type.Object({
  idempotencyKey: Id,
  jobId: Id,
  draftId: Id,
  to: SafeHeader,
  subject: Type.String({ maxLength: 998, pattern: "^[^\\r\\n]*$" }),
  draftHash: Hash,
  bodyHash: Hash,
  threadId: Type.Optional(Id),
  approvalId: Id,
  receiptNonce: Id,
  revision: Type.Integer({ minimum: 0 }),
  expiresAt: Type.String({ minLength: 20, maxLength: 40 }),
}, { additionalProperties: false })
export type GmailSendInput = Static<typeof GmailSendInputSchema>

export const GmailThreadOutputSchema = Type.Object({
  threadId: Type.Union([Id, Type.Null()]),
  messages: Type.Array(Type.Object({
    messageId: Id,
    threadId: Type.Union([Id, Type.Null()]),
    subject: Type.String(),
    senderEmail: Type.Union([Type.String(), Type.Null()]),
    snippet: Type.String(),
    body: Type.String(),
    receivedAt: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false }), { maxItems: 100 }),
}, { additionalProperties: false })

export const GmailDraftOutputSchema = Type.Object({
  draftId: Id, messageId: Type.Union([Id, Type.Null()]), threadId: Type.Union([Id, Type.Null()]),
  draftHash: Hash, bodyHash: Hash, status: Type.Literal("drafted"),
}, { additionalProperties: false })

export const GmailSendOutputSchema = Type.Object({
  status: Type.Union([Type.Literal("sent"), Type.Literal("duplicate")]),
  messageId: Id, threadId: Type.Union([Id, Type.Null()]), evidenceId: Id,
  tracked: Type.Boolean(), jobId: Id,
}, { additionalProperties: false })

export type GmailThreadOutput = Static<typeof GmailThreadOutputSchema>
export type GmailDraftOutput = Static<typeof GmailDraftOutputSchema>
export type GmailSendOutput = Static<typeof GmailSendOutputSchema>

export interface GmailCredential {
  readonly accessToken: string
  readonly scope: string | null
}

export interface GmailCredentialPort {
  getAccessToken(userId: string): Promise<GmailCredential | null>
}

export interface GmailClientPort {
  getThread(accessToken: string, input: GmailGetThreadInput, signal: AbortSignal): Promise<GmailThreadOutput>
  createDraft(accessToken: string, input: GmailCreateDraftInput, signal: AbortSignal): Promise<{ draftId: string; messageId: string | null; threadId: string | null }>
  sendDraft(accessToken: string, draftId: string, signal: AbortSignal): Promise<{ messageId: string; threadId: string | null }>
}

export interface GmailOAuthWaitPort {
  suspend(input: {
    context: ToolExecutionContext
    reason: "gmail_reauthorization_required"
  }): Promise<{ waitId: string; reconnectUrl: string }>
}

export interface GmailApprovalPort {
  consumeAndReserve(approvalId: string, expected: ApprovalScopeMatch, idempotencyKey: string): Promise<ApprovalConsumeResult>
}

export interface GmailSendEvidence {
  readonly evidenceId: string
  readonly messageId: string
  readonly threadId: string | null
  readonly jobId: string
  readonly idempotencyKey: string
  readonly tracked: boolean
}

export interface GmailEvidencePort {
  findSendEvidence(userId: string, idempotencyKey: string): Promise<GmailSendEvidence | null>
  hasSendReservation(userId: string, idempotencyKey: string): Promise<boolean>
  persistSendEvidence(input: {
    userId: string
    sessionId: string
    turnId: string
    jobId: string
    messageId: string
    threadId: string | null
    idempotencyKey: string
    subject: string
  }): Promise<GmailSendEvidence>
}

export interface GmailToolOptions {
  readonly credentials: GmailCredentialPort
  readonly client: GmailClientPort
  readonly approvals: (userId: string) => GmailApprovalPort
  readonly evidence: GmailEvidencePort
  readonly oauth: GmailOAuthWaitPort
}

export async function buildGmailApprovalScope(input: Pick<GmailSendInput, "jobId" | "draftId" | "to" | "subject" | "draftHash" | "bodyHash" | "threadId" | "revision" | "expiresAt" | "receiptNonce">, userId: string, sessionId: string, turnId: string, toolCallId: string): Promise<ApprovalScopeMatch> {
  const resource = { jobId: input.jobId, draftId: input.draftId, threadId: input.threadId ?? null }
  const material = { draftId: input.draftId, to: input.to, subject: input.subject, draftHash: input.draftHash, bodyHash: input.bodyHash }
  return {
    userId, sessionId, turnId, jobId: input.jobId, toolCallId, action: "send_gmail",
    resourceHash: await hashAgentReceiptValue("resource", resource),
    materialHash: await hashAgentReceiptValue("material", material),
    answersHash: await hashAgentReceiptValue("answers", null),
    revision: input.revision, expiresAt: new Date(input.expiresAt), nonce: input.receiptNonce,
  }
}
