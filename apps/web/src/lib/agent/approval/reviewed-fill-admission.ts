import type { PrismaClient } from "@prisma/client"
import { reviewedFillHandoffIdempotencyKey, type ReviewedFillHandoffIntent } from "@jobcopilot/shared"

import { db } from "@/lib/db"
import { requireLegacyPolicy } from "@/lib/agent/policy/legacy"
import {
  applicationFillTaskGraphEnabled, assertActiveAccount, assertJobPreflight, assertUnattendedApplyEnabled,
  AutoApplyError, validateAutoApplyUrl,
} from "@/lib/auto-apply-guards"
import { AgentCommandError } from "../control-plane/commands/errors"
import { lockApplicationFillTask } from "../control-plane/commands/application-fill-preflight"
import { findExistingCommand, lockOpenSession } from "../control-plane/commands/transaction"
import type { CommandIdentity, CommandResult } from "../control-plane/commands/types"
import { existingFillCommandResult, validateReviewedFillHandoff } from "./reviewed-fill-handoff"

export type ReviewedFillDuplicateProbe = { kind: "none" } | { kind: "duplicate"; result: CommandResult }

/** Read-only except for row locks; it never accepts inputs or creates a Turn. */
export async function acknowledgeExistingReviewedFillHandoff(
  client: PrismaClient,
  intent: ReviewedFillHandoffIntent,
  clientMessageId: string,
): Promise<ReviewedFillDuplicateProbe> {
  if (reviewedFillHandoffIdempotencyKey(intent.approvalId) !== clientMessageId) {
    throw new AgentCommandError("invalid_command", "Reviewed fill handoff key is invalid", 422)
  }
  const identity: CommandIdentity = { userId: intent.userId, sessionId: intent.sessionId, clientMessageId, source: "user" }
  return client.$transaction(async (tx) => {
    await lockOpenSession(tx, intent.sessionId, intent.userId)
    const existing = await findExistingCommand(tx, intent.sessionId, clientMessageId)
    const { task } = await lockApplicationFillTask(tx, intent.applicationTaskId, identity, false)
    if (!task) throw new AgentCommandError("agent_session_not_found", "Application task not found", 404)
    const accepted = await validateReviewedFillHandoff(tx, {
      approvalId: intent.approvalId, predecessorTurnId: intent.predecessorTurnId,
      applicationTaskId: intent.applicationTaskId, userId: intent.userId, sessionId: intent.sessionId,
      clientMessageId,
    })
    if (existing) {
      if (!existing.targetTurnId || existing.targetTurnId !== task.fillTurnId) {
        throw new AgentCommandError("retry_target_invalid", "Reviewed fill replay has conflicting task state", 409)
      }
      return { kind: "duplicate", result: await existingFillCommandResult(tx, existing.targetTurnId, identity, accepted.sourceTurnId, existing) }
    }
    if (!task.fillTurnId) return { kind: "none" }
    if (task.fillTurnSessionId !== identity.sessionId || task.fillTurnUserId !== identity.userId) {
      throw new AgentCommandError("agent_session_not_found", "Application fill ownership did not match", 404)
    }
    return { kind: "duplicate", result: await existingFillCommandResult(tx, task.fillTurnId, identity, accepted.sourceTurnId) }
  })
}

/** Applies the same product, URL, job and policy gates as the explicit fill entry. */
export async function assertReviewedFillLaunchAllowed(
  intent: Pick<ReviewedFillHandoffIntent, "userId" | "sessionId" | "applicationTaskId">,
): Promise<void> {
  await assertActiveAccount(intent.userId)
  await assertUnattendedApplyEnabled(intent.userId, { preserveUnexpectedErrors: true })
  const task = await db.applicationTask.findFirst({
    where: { id: intent.applicationTaskId, userId: intent.userId, sessionId: intent.sessionId },
    select: { jobId: true },
  })
  if (!task?.jobId) throw new AutoApplyError("The application task is unavailable for a reviewed fill.")
  const job = await db.job.findFirst({ where: { id: task.jobId, userId: intent.userId }, select: { url: true } })
  if (!job) throw new AutoApplyError("The application job is unavailable for a reviewed fill.")
  validateAutoApplyUrl(job.url)
  await assertJobPreflight({ userId: intent.userId, jobId: task.jobId })
  try {
    requireLegacyPolicy({
      userId: intent.userId, sessionId: `application:${intent.applicationTaskId}`,
      turnId: `fill:${intent.applicationTaskId}`, stepId: "application.fill",
      toolCallId: `fill:${intent.applicationTaskId}`, toolName: "application.fill",
      domain: "application", risk: "internal_write", capabilities: ["read", "write", "browser"],
      input: { requiresReceipt: false, unknownSensitiveFacts: false, resumeAfterUserInput: false },
    })
  } catch {
    throw new AutoApplyError("Application fill was denied by policy.")
  }
  if (!applicationFillTaskGraphEnabled()) throw new AutoApplyError("Reviewed material fill requires enabled TaskGraph fill.")
}
