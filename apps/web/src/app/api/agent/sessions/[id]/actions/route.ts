import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { applicationFillTaskGraphEnabled, queueApplicationFill, queueAutonomousApplication } from "@/lib/auto-apply"
import { resolveLegacyApproval } from "@/lib/agent/approval/legacy-receipt"
import { updateAgentSession } from "@/lib/agent/session/repository"
import { requireLegacyPolicy } from "@/lib/agent/policy/legacy"
import { resumeLegacyApprovalTurnInTransaction } from "@/lib/agent/approval/legacy-approval-fence"
import { isFeatureAllowed, resolveAiAccess } from "@/lib/entitlements"
import {
  applicationPayload, approvalPolicyInput, approvalTitle, canonicalApprovalResponse, legacyApprovalErrorResponse,
  policyErrorResponse, readBody, safeEventFields, serializeEvent, type ScopedApproval,
} from "@/lib/agent/session-actions/support"
import {
  consumeReceiptForApproval, handleApprovedResumeTailoring, handleConfirmedTailoredResume,
  handleCreateAutomationAction, handleRetryApplicationFillAction, handleConfirmSubmissionNotReceivedAction, handleReviewApplicationApproval,
  validateReceiptForApproval,
} from "@/lib/agent/session-actions/handlers"

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await ctx.params
  const session = await db.agentSession.findFirst({ where: { id, userId: auth.userId }, select: { id: true } })
  if (!session) return err("Session not found", 404)

  const action = readBody(await req.json().catch(() => null))
  if (!action) return err("Unsupported action type", 400)
  if (action.type === "create_automation") return handleCreateAutomationAction(id, auth.userId, action)
  if (action.type === "retry_application_fill") return handleRetryApplicationFillAction(id, auth.userId, action)
  if (action.type === "confirm_submission_not_received") return handleConfirmSubmissionNotReceivedAction(id, auth.userId, action)

  let approval: ScopedApproval | null = null
  let canonicalSubmissionApproved = false
  if (action.approvalId) {
    approval = await db.agentApproval.findFirst({
      where: { id: action.approvalId, sessionId: id, userId: auth.userId, status: "pending" },
      select: {
        id: true, type: true, payload: true, turnId: true, toolCallId: true, jobId: true,
        revision: true, expiresAt: true, resourceHash: true, materialHash: true, answersHash: true,
      },
    })
    if (!approval) {
      if (action.decision === "approved" && applicationFillTaskGraphEnabled()) {
        const prior = await db.agentApproval.findFirst({
          where: { id: action.approvalId, sessionId: id, userId: auth.userId, status: "approved", type: "review_application" },
          select: { payload: true },
        })
        const payload = applicationPayload(prior?.payload)
        if (payload) {
          const task = await db.applicationTask.findFirst({
            where: { id: payload.applicationTaskId, userId: auth.userId, sessionId: id, jobId: payload.jobId },
            select: { fillTurnId: true },
          })
          if (task?.fillTurnId) return ok({ turnId: task.fillTurnId, taskId: task.fillTurnId, duplicate: true })
          const job = await db.job.findFirst({ where: { id: payload.jobId, userId: auth.userId }, select: { url: true } })
          if (job) {
            try {
              const queued = await queueApplicationFill({
                userId: auth.userId, jobId: payload.jobId, applyUrl: job.url,
                applicationTaskId: payload.applicationTaskId, sessionId: id,
              })
              return ok({ ...queued, duplicate: true })
            } catch (error) {
              return err(error instanceof Error ? error.message : "Could not resume the form-fill review pass", 409)
            }
          }
        }
      }
      return err("Approval is no longer pending", 409)
    }

    const policy = approvalPolicyInput(approval)
    try {
      requireLegacyPolicy({
        userId: auth.userId,
        sessionId: id,
        turnId: approval.turnId ?? "legacy-approval:" + action.approvalId,
        stepId: "approval:" + action.approvalId,
        toolCallId: approval.toolCallId ?? "approval:" + action.approvalId,
        toolName: policy.toolName,
        domain: policy.domain,
        risk: action.decision === "approved" ? policy.risk : "internal_write",
        capabilities: policy.capabilities,
        input: {
          requiresReceipt: action.decision === "approved",
          receiptValidated: Boolean(action.receiptNonce),
          unknownSensitiveFacts: false,
        },
      })
    } catch (error) {
      return policyErrorResponse(error)
    }
    if (action.decision === "approved" && !action.receiptNonce) return err("A scoped receipt is required to approve this action", 428)
    if (action.decision === "approved" && approval.type === "tailor_resume") {
      if (!(await isFeatureAllowed(auth.userId, "tailored_resume"))) return err("This feature is not included in your current plan", 403)
      const aiAccess = await resolveAiAccess(auth.userId)
      if (aiAccess === "disabled") return err("This feature is not included in your current plan", 403)
      if (aiAccess === "exhausted") return err("Monthly AI credits exhausted", 429)
    }
    try {
      const resolution = await resolveLegacyApproval(db, {
        approval,
        userId: auth.userId,
        sessionId: id,
        decision: action.decision === "approved" ? "approved" : "rejected",
      }, {
        beforeResolve: action.decision === "approved"
          ? () => validateReceiptForApproval(approval!, action.receiptNonce!, auth.userId, id)
          : undefined,
      })
      if (resolution?.disposition === "canonical_wait") {
        const canonicalSubmissionDeclined = approval.type === "submit_application"
          && (action.decision === "rejected" || action.decision === "cancelled")
          && resolution.decision === "rejected"
          && resolution.result.status === "rejected"
          && resolution.result.disposition !== "duplicate"
        if (canonicalSubmissionDeclined && approval.turnId && approval.jobId) {
          const payload = applicationPayload(approval.payload)
          if (payload?.jobId === approval.jobId) {
            const cancelled = action.decision === "cancelled"
            const updated = await db.applicationTask.updateMany({
              where: {
                id: payload.applicationTaskId, userId: auth.userId, jobId: payload.jobId, sessionId: id,
                fillTurnId: approval.turnId, fillTurnSessionId: id, fillTurnUserId: auth.userId,
                status: "waiting_for_authorization", checkpoint: "form_filled",
              },
              data: {
                status: cancelled ? "cancelled" : "waiting_for_user",
                checkpoint: cancelled ? "submission_cancelled" : "review_requested",
                completedAt: cancelled ? new Date() : null,
              },
            })
            if (updated.count === 1) {
              await db.applicationTaskEvent.create({
                data: {
                  taskId: payload.applicationTaskId, type: "submission_" + action.decision, actor: "user",
                  body: safeEventFields("submission_" + action.decision, action.body, {}).body,
                },
              })
            }
          }
        }
        canonicalSubmissionApproved = action.decision === "approved"
          && resolution.decision === "approved"
          && approval.type === "submit_application"
          && resolution.result.disposition !== "duplicate"
        if (!canonicalSubmissionApproved) return canonicalApprovalResponse(resolution)
      }
      if (!canonicalSubmissionApproved) {
        if (approval.turnId) await resumeLegacyApprovalTurnInTransaction(db, { sessionId: id, userId: auth.userId, turnId: approval.turnId })
        if (action.decision === "approved" && approval.type !== "submit_application") {
          await consumeReceiptForApproval(approval, action.receiptNonce!, auth.userId, id)
        }
      }
    } catch (error) {
      return legacyApprovalErrorResponse(error, "Approval could not be resolved")
    }
  }
  if (action.decision === "approved" && approval?.type === "tailor_resume") {
    return handleApprovedResumeTailoring(id, auth.userId, action, approval)
  }
  if (action.decision === "approved" && approval?.type === "confirm_tailored_resume") {
    return handleConfirmedTailoredResume(id, auth.userId, approval)
  }
  if (approval?.type === "review_application") {
    const response = await handleReviewApplicationApproval(id, auth.userId, action, approval)
    if (response) return response
  }

  if (action.decision === "approved" && approval?.type === "submit_application") {
    const payload = applicationPayload(approval.payload)
    if (!payload) return err("Submission authorization is missing its task.", 400)
    const job = await db.job.findFirst({ where: { id: payload.jobId, userId: auth.userId }, select: { url: true } })
    if (!job) return err("Job not found", 404)
    let queued: { taskId: string }
    try {
      queued = await queueAutonomousApplication({
        userId: auth.userId, jobId: payload.jobId, applyUrl: job.url, applicationTaskId: payload.applicationTaskId,
        approvalId: action.approvalId!, receiptNonce: action.receiptNonce!, sessionId: id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not queue the approved application."
      await db.applicationTask.updateMany({
        where: { id: payload.applicationTaskId, userId: auth.userId, status: "waiting_for_authorization" },
        data: { status: "waiting_for_authorization", checkpoint: "queue_retry", error: message },
      })
      return err(message, 409)
    }

    let projectedEvent: ReturnType<typeof serializeEvent> | null = null
    try {
      const event = await db.agentTranscriptEvent.create({
        data: {
          sessionId: id, taskId: null, type: "application_queued", speaker: "Executor",
          title: "Submission queued", durationMs: null,
          ...safeEventFields("application_queued", "Your approved application was queued for background execution.", { ...queued, jobId: payload.jobId }),
        },
      })
      projectedEvent = serializeEvent(event)
      await updateAgentSession(db, { sessionId: id, status: "running", completedAt: null })
      return ok({ event: projectedEvent })
    } catch {
      return ok({ event: projectedEvent, queued: true, taskId: queued.taskId, projectionPending: true })
    }
  }

  if (approval?.type === "submit_application") {
    const payload = applicationPayload(approval.payload)
    if (payload) {
      const updated = await db.applicationTask.updateMany({
        where: {
          id: payload.applicationTaskId,
          userId: auth.userId,
          jobId: payload.jobId,
          status: "waiting_for_authorization",
          OR: [{ checkpoint: null }, { checkpoint: { notIn: ["submission_request_started", "submission_uncertain"] } }],
        },
        data: {
          status: action.decision === "cancelled" ? "cancelled" : "waiting_for_user",
          checkpoint: action.decision === "cancelled" ? "submission_cancelled" : "review_requested",
          completedAt: action.decision === "cancelled" ? new Date() : null,
        },
      })
      if (updated.count === 1) {
        await db.applicationTaskEvent.create({
          data: {
            taskId: payload.applicationTaskId, type: "submission_" + action.decision, actor: "user",
            body: safeEventFields("submission_" + action.decision, action.body, {}).body,
          },
        })
      }
    }
  }

  const event = await db.agentTranscriptEvent.create({
    data: {
      sessionId: id, taskId: null, type: "approval_response", speaker: "You",
      title: approvalTitle(action.decision), durationMs: null,
      ...safeEventFields("approval_response", action.body, { approvalId: action.approvalId, decision: action.decision }),
    },
  })
  await updateAgentSession(db, { sessionId: id, status: "completed", completedAt: new Date() })
  return ok({ event: serializeEvent(event as Parameters<typeof serializeEvent>[0]) })
}
