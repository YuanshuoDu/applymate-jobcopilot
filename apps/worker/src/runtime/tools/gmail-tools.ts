import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import { ToolExecutionError, type RuntimeToolDefinition, type ToolExecutionContext } from "./types.js"
import {
  buildGmailApprovalScope, GmailCreateDraftInputSchema, GmailDraftOutputSchema, GmailGetThreadInputSchema,
  GmailSendInputSchema, GmailSendOutputSchema, GmailThreadOutputSchema,
  type GmailCreateDraftInput, type GmailGetThreadInput, type GmailSendInput, type GmailToolOptions,
} from "./gmail-types.js"

export function createGmailTools(options: GmailToolOptions): RuntimeToolDefinition[] {
  return [
    {
      ...metadata("gmail.get_thread", "Read a tenant-scoped Gmail thread or message", ["read"], "read", "read_only"),
      inputSchema: GmailGetThreadInputSchema, outputSchema: GmailThreadOutputSchema,
      execute: (context, input) => withCredential(context, options, "read", (token) => options.client.getThread(token, input as GmailGetThreadInput, context.signal)),
    },
    {
      ...metadata("gmail.create_draft", "Create a Gmail draft without sending it", ["read", "write"], "internal_write", "requires_key"),
      inputSchema: GmailCreateDraftInputSchema, outputSchema: GmailDraftOutputSchema,
      execute: (context, input) => createDraft(context, input as GmailCreateDraftInput, options),
    },
    {
      ...metadata("gmail.send", "Send exactly one previously created Gmail draft after explicit approval", ["read", "write", "external_write"], "external_write", "non_repeatable"),
      inputSchema: GmailSendInputSchema, outputSchema: GmailSendOutputSchema,
      execute: (context, input) => sendDraft(context, input as GmailSendInput, options),
    },
  ]
}

async function createDraft(context: ToolExecutionContext, input: GmailCreateDraftInput, options: GmailToolOptions) {
  return withCredential(context, options, "draft", async (token) => {
    const ids = await options.client.createDraft(token, input, context.signal)
    return {
      draftId: ids.draftId, messageId: ids.messageId, threadId: ids.threadId,
      draftHash: await hashAgentReceiptValue("gmail-draft", { to: input.to, subject: input.subject, body: input.body, threadId: input.threadId ?? null }),
      bodyHash: await hashAgentReceiptValue("gmail-body", input.body), status: "drafted" as const,
    }
  })
}

async function sendDraft(context: ToolExecutionContext, input: GmailSendInput, options: GmailToolOptions) {
  const existing = await options.evidence.findSendEvidence(context.scope.userId, input.idempotencyKey)
  if (existing) return { status: "duplicate" as const, messageId: existing.messageId, threadId: existing.threadId, evidenceId: existing.evidenceId, tracked: existing.tracked, jobId: existing.jobId }
  if (await options.evidence.hasSendReservation(context.scope.userId, input.idempotencyKey)) {
    throw new ToolExecutionError("gmail_send_uncertain", "The Gmail send already has a durable reservation and needs reconciliation before retrying")
  }
  return withCredential(context, options, "send", async (token) => {
    const expected = await buildGmailApprovalScope(input, context.scope.userId, context.sessionId, context.turnId, context.toolCallId ?? "")
    try {
      await options.approvals(context.scope.userId).consumeAndReserve(input.approvalId, expected, input.idempotencyKey)
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "gmail_approval_invalid"
      throw new ToolExecutionError(code, "The Gmail approval is missing, expired, consumed, or out of scope")
    }
    const sent = await options.client.sendDraft(token, input.draftId, context.signal)
    try {
      return await options.evidence.persistSendEvidence({ userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, jobId: input.jobId, messageId: sent.messageId, threadId: sent.threadId ?? input.threadId ?? null, idempotencyKey: input.idempotencyKey, subject: input.subject })
    } catch {
      throw new ToolExecutionError("gmail_evidence_persistence_failed", "Gmail delivery evidence could not be persisted; do not retry automatically")
    }
  }).then((evidence) => ({ status: "sent" as const, messageId: evidence.messageId, threadId: evidence.threadId, evidenceId: evidence.evidenceId, tracked: evidence.tracked, jobId: evidence.jobId }))
}

async function withCredential<T>(context: ToolExecutionContext, options: GmailToolOptions, operation: "read" | "draft" | "send", work: (token: string) => Promise<T>): Promise<T> {
  const credential = await options.credentials.getAccessToken(context.scope.userId)
  if (!credential) {
    const wait = await options.oauth.suspend({ context, reason: "gmail_reauthorization_required" })
    throw new ToolExecutionError("gmail_oauth_required", "Reconnect Gmail to continue this Turn", { status: "waiting_for_oauth", waitId: wait.waitId, reconnectUrl: wait.reconnectUrl })
  }
  if (credential.scope) {
    const scopes = new Set(credential.scope.split(/\s+/))
    const required = operation === "send"
      ? ["https://www.googleapis.com/auth/gmail.send", "https://mail.google.com/"]
      : operation === "draft"
        ? ["https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"]
        : []
    if (required.length > 0 && !required.some(scope => scopes.has(scope))) {
      throw new ToolExecutionError("gmail_scope_denied", operation === "send" ? "The connected Gmail account has no send permission" : "The connected Gmail account has no draft permission")
    }
  }
  return work(credential.accessToken)
}

function metadata(name: string, description: string, capabilities: readonly ["read"] | readonly ["read", "write"] | readonly ["read", "write", "external_write"], risk: "read" | "internal_write" | "external_write", idempotency: "read_only" | "requires_key" | "non_repeatable") {
  return { schemaVersion: schemaVersion as "agent-harness.v2", name, version: "1", description, capabilities, risk, domain: "gmail" as const, idempotency, timeoutMs: 30_000, requiredCapabilities: [] as const }
}
