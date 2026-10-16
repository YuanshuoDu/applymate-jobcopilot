import { Prisma } from "@prisma/client"
import { redactAgentEvent } from "@jobcopilot/shared"
import { hashApprovalNonce } from "@jobcopilot/agent-protocol"
import { err, ok } from "@/lib/api-helpers"
import { resolveLegacyApproval, type ScopedApprovalRecord } from "@/lib/agent/approval/legacy-receipt"
import { db } from "@/lib/db"
import { queueAutonomousApplication } from "@/lib/auto-apply"
import { requireLegacyPolicy } from "@/lib/agent/policy/legacy"

export type ApprovalDecision = "approved" | "rejected" | "cancelled" | "review"

export type ApprovalAction = {
  type: "approval_response"
  approvalId: string | null
  decision: ApprovalDecision
  body: string
  receiptNonce: string | null
}

export type CreateAutomationAction = {
  type: "create_automation"
  draft: AutomationDraft
  approvalId: string | null
  receiptNonce: string | null
}

export type RetryApplicationFillAction = {
  type: "retry_application_fill"
  applicationTaskId: string
  requestId: string
}

export type ConfirmSubmissionNotReceivedAction = {
  type: "confirm_submission_not_received"
  applicationTaskId: string
  requestId: string
  confirmedNotReceived: true
}

export type SessionAction = ApprovalAction | CreateAutomationAction | RetryApplicationFillAction | ConfirmSubmissionNotReceivedAction

export type ScopedApproval = ScopedApprovalRecord & {
  resourceHash: string | null
  materialHash: string | null
  answersHash: string | null
}

export type AutomationDraft = {
  name: string
  triggerType: string
  cron: string | null
  timezone: string
  targetRoles: string[]
  targetLocations: string[]
  minScore: number
  dailyCap: number
  requireApproval: boolean
  autoApply: boolean
}

export function readBody(body: unknown): SessionAction | null {
  if (!body || typeof body !== "object") return null
  const row = body as Record<string, unknown>
  if (row.type === "create_automation") {
    const draft = readAutomationDraft(row.draft)
    return draft ? {
      type: "create_automation", draft,
      approvalId: typeof row.approvalId === "string" && row.approvalId ? row.approvalId : null,
      receiptNonce: typeof row.receiptNonce === "string" && row.receiptNonce ? row.receiptNonce : null,
    } : null
  }
  if (row.type === "retry_application_fill") {
    const applicationTaskId = text(row.applicationTaskId)
    const requestId = text(row.requestId)
    return applicationTaskId && /^[A-Za-z0-9_-]{8,128}$/.test(requestId)
      ? { type: "retry_application_fill", applicationTaskId, requestId }
      : null
  }
  if (row.type === "confirm_submission_not_received") {
    const applicationTaskId = text(row.applicationTaskId)
    const requestId = text(row.requestId)
    return applicationTaskId && row.confirmedNotReceived === true && /^[A-Za-z0-9_-]{8,128}$/.test(requestId)
      ? { type: "confirm_submission_not_received", applicationTaskId, requestId, confirmedNotReceived: true }
      : null
  }
  if (row.type !== "approval_response") return null
  const rawDecision = typeof row.decision === "string" ? row.decision : "review"
  const decision = isApprovalDecision(rawDecision) ? rawDecision : "review"
  return {
    type: row.type,
    approvalId: typeof row.approvalId === "string" && row.approvalId ? row.approvalId : null,
    decision,
    body: typeof row.body === "string" && row.body.trim() ? row.body.trim() : approvalBody(decision),
    receiptNonce: typeof row.receiptNonce === "string" && row.receiptNonce.trim() ? row.receiptNonce.trim() : null,
  }
}

function readAutomationDraft(value: unknown): AutomationDraft | null {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const name = text(row.name)
  if (!name) return null
  return {
    name,
    triggerType: text(row.triggerType) || "manual",
    cron: text(row.cron) || null,
    timezone: text(row.timezone) || "Europe/Berlin",
    targetRoles: stringList(row.targetRoles),
    targetLocations: stringList(row.targetLocations),
    minScore: numberInRange(row.minScore, 85, 0, 100),
    dailyCap: numberInRange(row.dailyCap, 8, 1, 50),
    requireApproval: bool(row.requireApproval, true),
    autoApply: bool(row.autoApply, false),
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map(item => text(item)).filter(Boolean)
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function numberInRange(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function isApprovalDecision(value: string): value is ApprovalDecision {
  return value === "approved" || value === "rejected" || value === "cancelled" || value === "review"
}

function approvalBody(decision: ApprovalDecision) {
  if (decision === "approved") return "Approved the requested action."
  if (decision === "rejected") return "Rejected the requested action."
  if (decision === "cancelled") return "Cancelled the requested action."
  return "Asked to review the requested action."
}

export function approvalTitle(decision: ApprovalDecision) {
  if (decision === "approved") return "Approved"
  if (decision === "rejected") return "Rejected"
  if (decision === "cancelled") return "Cancelled"
  return "Review requested"
}

export function serializeEvent(event: {
  id: string
  sessionId: string
  taskId: string | null
  type: string
  speaker: string
  title: string | null
  body: string
  data: unknown
  durationMs: number | null
  createdAt: Date
}) {
  return { ...event, createdAt: event.createdAt.toISOString() }
}

export function resumeTailoringPayload(value: unknown) {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const resumeId = text(payload.resumeId)
  const jobId = text(payload.jobId)
  return resumeId && jobId ? { resumeId, jobId } : null
}

export function applicationPayload(value: unknown) {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const applicationTaskId = text(payload.applicationTaskId)
  const jobId = text(payload.jobId)
  return applicationTaskId && jobId ? { applicationTaskId, jobId } : null
}

export async function replayConsumedSubmitApproval(input: {
  sessionId: string
  userId: string
  approvalId: string
  receiptNonce: string
}): Promise<Response | null> {
  const prior = await db.agentApproval.findFirst({
    where: { id: input.approvalId, sessionId: input.sessionId, userId: input.userId, status: { in: ["approved", "consumed"] }, type: "submit_application" },
    select: { payload: true, nonceHash: true },
  })
  const payload = applicationPayload(prior?.payload)
  if (!payload || prior?.nonceHash !== await hashApprovalNonce(input.receiptNonce)) return null
  try {
    const queued = await queueAutonomousApplication({
      userId: input.userId, jobId: payload.jobId, applyUrl: null, applicationTaskId: payload.applicationTaskId,
      approvalId: input.approvalId, receiptNonce: input.receiptNonce, sessionId: input.sessionId, replayOnly: true,
    })
    return ok({ queued: true, taskId: queued.taskId, duplicate: true })
  } catch (error) {
    return err(error instanceof Error ? error.message : "The existing submission intent could not be resolved", 409)
  }
}

export function approvalPolicyInput(approval: ScopedApproval) {
  if (approval.type === "submit_application") return { toolName: "application.submit", domain: "application" as const, risk: "external_write" as const, capabilities: ["read", "write", "external_write"] as const }
  if (approval.type === "review_application") return { toolName: "application.fill", domain: "application" as const, risk: "internal_write" as const, capabilities: ["read", "write", "browser"] as const }
  if (approval.type === "send_gmail") return { toolName: "gmail.send", domain: "gmail" as const, risk: "external_write" as const, capabilities: ["read", "write", "external_write"] as const }
  if (approval.type === "automation_mutation") return { toolName: "automation.mutate", domain: "automation" as const, risk: "internal_write" as const, capabilities: ["read", "write"] as const }
  return { toolName: "resume.tailor", domain: "resume" as const, risk: "draft_write" as const, capabilities: ["read", "write"] as const }
}

export function approvalActionPolicyError(approval: ScopedApproval, decision: ApprovalDecision, receiptValidated: boolean, userId: string, sessionId: string): Response | null {
  const policy = approvalPolicyInput(approval)
  try {
    requireLegacyPolicy({
      userId, sessionId, turnId: approval.turnId ?? "legacy-approval:" + approval.id,
      stepId: "approval:" + approval.id, toolCallId: approval.toolCallId ?? "approval:" + approval.id,
      toolName: policy.toolName, domain: policy.domain, risk: decision === "approved" ? policy.risk : "internal_write",
      capabilities: policy.capabilities,
      input: { requiresReceipt: decision === "approved", receiptValidated, unknownSensitiveFacts: false },
    })
    return null
  } catch (error) {
    return policyErrorResponse(error)
  }
}

export function policyErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "The policy did not permit this action"
  const status = error && typeof error === "object" && "outcome" in error && (error as { outcome?: unknown }).outcome === "require_user_input" ? 422 : 428
  return err(message, status)
}

export function legacyApprovalErrorResponse(error: unknown, fallback: string) {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
  if (code === "approval_wait_active") return Response.json({ error: error instanceof Error ? error.message : fallback, code }, { status: 409 })
  return err(error instanceof Error ? error.message : fallback, 409)
}

export function canonicalApprovalResponse(resolution: Extract<Awaited<ReturnType<typeof resolveLegacyApproval>>, { disposition: "canonical_wait" }>) {
  return ok({ disposition: resolution.decision, duplicate: resolution.result.disposition === "duplicate" }, 202)
}

export function safeEventFields(type: string, body: string, data: unknown) {
  const safe = redactAgentEvent({ type, body, data })
  return { body: safe.body, ...(safe.data === null ? {} : { data: safe.data as Prisma.InputJsonValue }) }
}
