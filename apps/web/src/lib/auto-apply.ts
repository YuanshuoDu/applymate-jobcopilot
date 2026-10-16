import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { hashApprovalNonce, hashApprovalScope, type ApprovalScope } from "@jobcopilot/agent-protocol";
import { hashAgentReceiptValue, matchesApplyTaskSubmitPayload, type ApplyTaskSubmitPayload } from "@jobcopilot/shared";
import { createSubmitIntent, enqueueApplyTask, isReplayableSubmitState, resolveExistingSubmitIntent } from "@/lib/apply-queue-client";
import { AgentCommandService } from '@/lib/agent/control-plane/commands/agent-command-service'
import { requireLegacyPolicy } from '@/lib/agent/policy/legacy'
import { applicationFillTaskGraphEnabled, asRecord, assertActiveAccount, assertJobPreflight, assertUnattendedApplyEnabled, AutoApplyError, validateAutoApplyUrl } from "./auto-apply-guards";

export { AutoApplyError, applicationFillTaskGraphEnabled, validateAutoApplyUrl } from "./auto-apply-guards";

/** Dispatches the safe first browser pass: fill fields, then stop for review. */
export async function queueApplicationFill(input: {
  userId: string;
  jobId: string;
  applyUrl: string | null | undefined;
  applicationTaskId: string;
  resumeAfterUserInput?: boolean;
  sessionId?: string;
  retry?: boolean;
  retryId?: string;
}): Promise<{ taskId: string; turnId?: string; disposition?: string }> {
  await assertActiveAccount(input.userId)
  await assertUnattendedApplyEnabled(input.userId)
  const applyUrl = validateAutoApplyUrl(input.applyUrl);
  await assertJobPreflight(input)
  try {
    requireLegacyPolicy({
      userId: input.userId, sessionId: `application:${input.applicationTaskId}`, turnId: `fill:${input.applicationTaskId}`,
      stepId: "application.fill", toolCallId: `fill:${input.applicationTaskId}`, toolName: "application.fill",
      domain: "application", risk: "internal_write", capabilities: ["read", "write", "browser"],
      input: { requiresReceipt: false, unknownSensitiveFacts: false, resumeAfterUserInput: input.resumeAfterUserInput === true },
    })
  } catch (error) {
    throw new AutoApplyError(error instanceof Error ? error.message : "Application fill was denied by policy.")
  }
  if (applicationFillTaskGraphEnabled()) {
    if (input.retry && (!input.retryId || !/^[A-Za-z0-9_-]{8,128}$/.test(input.retryId))) {
      throw new AutoApplyError("A valid retry request ID is required for an explicit application fill retry.")
    }
    const task = await db.applicationTask.findFirst({
      where: { id: input.applicationTaskId, userId: input.userId, jobId: input.jobId },
      select: { sessionId: true, fillTurnId: true },
    })
    if (!task?.sessionId || (input.sessionId && input.sessionId !== task.sessionId)) {
      throw new AutoApplyError("The application is missing its scoped Agent session.")
    }
    const clientMessageId = input.retry
      ? `application-fill-retry:${input.applicationTaskId}:${input.retryId}`
      : input.resumeAfterUserInput
        ? `application-fill-resume:${input.applicationTaskId}`
        : `application-fill:${input.applicationTaskId}`
    const result = await new AgentCommandService(db).startApplicationFillForReview({
      sessionId: task.sessionId, userId: input.userId, clientMessageId,
      applicationTaskId: input.applicationTaskId, retry: input.retry, resumeAfterUserInput: input.resumeAfterUserInput,
    })
    return { taskId: result.turnId, turnId: result.turnId, disposition: result.disposition }
  }
  const claimed = await db.applicationTask.updateMany({
    where: {
      id: input.applicationTaskId,
      userId: input.userId,
      jobId: input.jobId,
      status: "waiting_for_user",
      checkpoint: input.resumeAfterUserInput ? "form_answer_required" : "materials_ready",
    },
    data: { status: "filling", checkpoint: "form_fill_queued", question: Prisma.DbNull, startedAt: new Date() },
  });
  if (claimed.count !== 1) throw new AutoApplyError("This application is no longer ready for the form-fill review pass.");

  try {
    const taskId = await enqueueApplyTask({ applicationTaskId: input.applicationTaskId, jobId: input.jobId, userId: input.userId, applyUrl, operation: "fill" });
    await db.applicationTask.update({ where: { id: input.applicationTaskId }, data: { workerTaskId: taskId } });
    await db.applicationTaskEvent.create({ data: { taskId: input.applicationTaskId, type: "form_fill_queued", actor: "reviewer", body: "Material review approved; worker will fill the form without submitting it.", data: { workerTaskId: taskId } } });
    return { taskId };
  } catch (error) {
    await db.applicationTask.updateMany({ where: { id: input.applicationTaskId, status: "filling", checkpoint: "form_fill_queued" }, data: { status: "waiting_for_user", checkpoint: "materials_ready" } }).catch(() => undefined);
    throw error;
  }
}

export async function queueAutonomousApplication(input: {
  userId: string;
  jobId: string;
  applyUrl: string | null | undefined;
  applicationTaskId: string;
  /** Approved per-job authorization. Global settings can never replace this. */
  approvalId: string;
  receiptNonce?: string;
  sessionId?: string;
  /** Read-only replay of an already persisted submit intent. */
  replayOnly?: boolean;
}): Promise<{ taskId: string }> {
  await assertActiveAccount(input.userId)
  if (!input.replayOnly) await assertUnattendedApplyEnabled(input.userId)
  const applyUrl = input.replayOnly ? "" : validateAutoApplyUrl(input.applyUrl);
  if (!input.replayOnly) await assertJobPreflight(input)
  const approval = await db.agentApproval.findFirst({
    where: {
      id: input.approvalId, userId: input.userId, type: "submit_application",
      status: input.replayOnly ? { in: ["approved", "consumed"] } : "approved",
    },
    select: { id: true, payload: true, sessionId: true, turnId: true, toolCallId: true, jobId: true, revision: true, expiresAt: true, scopeHash: true, nonceHash: true, resourceHash: true, materialHash: true, answersHash: true },
  });
  const payload = asRecord(approval?.payload);
  const taskSnapshot = await db.applicationTask.findFirst({
    where: { id: input.applicationTaskId, userId: input.userId, jobId: input.jobId },
    select: { sessionId: true, fillTurnId: true, resumeId: true, coverLetterId: true, confirmedAnswers: true },
  });
  const material = {
    applicationTaskId: input.applicationTaskId,
    jobId: input.jobId,
    resumeId: taskSnapshot?.resumeId ?? null,
    coverLetterId: taskSnapshot?.coverLetterId ?? null,
  };
  const snapshotMaterialHash = await hashAgentReceiptValue("material", material);
  const snapshotAnswersHash = await hashAgentReceiptValue("answers", taskSnapshot?.confirmedAnswers ?? null);
  let replayReceiptValid = !input.replayOnly;
  if (input.replayOnly && approval && input.receiptNonce && approval.nonceHash && approval.resourceHash && approval.materialHash && approval.answersHash && approval.expiresAt && approval.sessionId && approval.turnId && approval.toolCallId && approval.jobId) {
    const scope: ApprovalScope = {
      userId: input.userId, sessionId: approval.sessionId, turnId: approval.turnId, jobId: approval.jobId,
      toolCallId: approval.toolCallId, action: "submit_application", resourceHash: approval.resourceHash,
      materialHash: approval.materialHash, answersHash: approval.answersHash, revision: approval.revision,
      nonceHash: approval.nonceHash, expiresAt: approval.expiresAt.toISOString(),
    };
    replayReceiptValid = approval.nonceHash === await hashApprovalNonce(input.receiptNonce) &&
      approval.scopeHash === await hashApprovalScope(scope);
  }
  if (!approval || !taskSnapshot?.sessionId || !taskSnapshot.fillTurnId ||
    (input.sessionId && input.sessionId !== taskSnapshot.sessionId) || approval.sessionId !== taskSnapshot.sessionId ||
    approval.turnId !== taskSnapshot.fillTurnId || payload.applicationTaskId !== input.applicationTaskId || payload.jobId !== input.jobId ||
    payload.resumeId !== material.resumeId || payload.coverLetterId !== material.coverLetterId ||
    ("confirmedAnswers" in payload && JSON.stringify(payload.confirmedAnswers ?? null) !== JSON.stringify(taskSnapshot?.confirmedAnswers ?? null)) ||
    approval.materialHash !== snapshotMaterialHash || approval.answersHash !== snapshotAnswersHash ||
    !approval.toolCallId || approval.jobId !== input.jobId || !approval.expiresAt ||
    !approval.scopeHash || !input.receiptNonce || !replayReceiptValid) {
    throw new AutoApplyError("A current, explicit approval is required before this application can be submitted.");
  }
  const receiptSessionId = taskSnapshot.sessionId;
  const fillTurnId = taskSnapshot.fillTurnId;

  try {
    if (!input.replayOnly) requireLegacyPolicy({
      userId: input.userId, sessionId: receiptSessionId, turnId: approval.turnId,
      stepId: `submit:${input.applicationTaskId}`, toolCallId: approval.toolCallId, toolName: "application.submit",
      domain: "application", risk: "external_write", capabilities: ["read", "write", "external_write"],
      input: { requiresReceipt: true, receiptValidated: true, unknownSensitiveFacts: false },
    });
  } catch (error) {
    throw new AutoApplyError(error instanceof Error ? error.message : "Submission policy denied this application.");
  }

  const submitPayload: ApplyTaskSubmitPayload = {
    applicationTaskId: input.applicationTaskId, jobId: input.jobId, userId: input.userId, applyUrl,
    personaId: "server-side", resumePath: "", operation: "submit", sessionId: receiptSessionId,
    fillTurnId, receiptId: approval.id, constraintHash: approval.scopeHash,
  };
  if (!matchesApplyTaskSubmitPayload(submitPayload, {
    applicationTaskId: input.applicationTaskId, userId: input.userId, jobId: input.jobId,
    sessionId: receiptSessionId, fillTurnId, receiptId: approval.id, constraintHash: approval.scopeHash,
  })) throw new AutoApplyError("The submit payload does not match the current approved application attempt.");

  const intent = createSubmitIntent(submitPayload);
  const taskId = await db.$transaction(async tx => {
    const taskWhere = { id: input.applicationTaskId, userId: input.userId, jobId: input.jobId, sessionId: receiptSessionId, fillTurnId };
    const current = await tx.applicationTask.findFirst({
      where: taskWhere,
      select: { status: true, checkpoint: true, workerTaskId: true, resumeId: true, coverLetterId: true, confirmedAnswers: true, question: true },
    });
    if (!current) return false;
    if (current.resumeId !== material.resumeId || current.coverLetterId !== material.coverLetterId ||
      JSON.stringify(current.confirmedAnswers ?? null) !== JSON.stringify(taskSnapshot.confirmedAnswers ?? null)) return false;
    if (current.workerTaskId === intent.payload.workerTaskId) {
      if (!isReplayableSubmitState(current.status, current.checkpoint)) return false;
      return resolveExistingSubmitIntent(tx, intent);
    }
    if (input.replayOnly) return false;
    if (current.status !== "waiting_for_authorization" || current.checkpoint !== "form_filled" || !current.resumeId || current.question !== null) return false;

    const resume = await tx.resume.findFirst({
      where: { id: current.resumeId, userId: input.userId, OR: [{ targetJobId: input.jobId }, { isDefault: true }] }, select: { id: true },
    });
    if (!resume) return false;
    if (current.coverLetterId && !await tx.coverLetter.findFirst({
      where: { id: current.coverLetterId, userId: input.userId, jobId: input.jobId, resumeId: current.resumeId }, select: { id: true },
    })) return false;

    const claim = await tx.applicationTask.updateMany({
      where: { ...taskWhere, workerTaskId: current.workerTaskId, status: "waiting_for_authorization", checkpoint: "form_filled",
        resumeId: material.resumeId, coverLetterId: material.coverLetterId,
        confirmedAnswers: { equals: taskSnapshot.confirmedAnswers === null ? Prisma.DbNull : taskSnapshot.confirmedAnswers as Prisma.InputJsonValue }, question: { equals: Prisma.DbNull } },
      data: { status: "filling", checkpoint: "submission_authorized", question: Prisma.DbNull, workerTaskId: intent.payload.workerTaskId, startedAt: new Date() },
    });
    if (claim.count !== 1) {
      const raced = await tx.applicationTask.findFirst({ where: taskWhere, select: { workerTaskId: true, status: true, checkpoint: true } });
      return raced?.workerTaskId === intent.payload.workerTaskId && isReplayableSubmitState(raced.status, raced.checkpoint)
        ? resolveExistingSubmitIntent(tx, intent) : false;
    }
    const job = await tx.job.updateMany({
      where: { id: input.jobId, userId: input.userId, status: "saved", workflowState: "ready_to_apply" },
      data: { workflowState: "queued", analysisNote: "[Approved submission] Applying in the background after explicit user authorization." },
    });
    if (job.count !== 1) throw new AutoApplyError("This application is no longer ready for the approved submission step.");

    const identity = intent.payload;
    await tx.applicationTaskEvent.create({ data: {
      taskId: input.applicationTaskId, type: "submission_queued", actor: "user", body: "User approved this job for background submission.",
      data: { applicationTaskId: identity.applicationTaskId, userId: identity.userId, jobId: identity.jobId,
        sessionId: identity.sessionId, fillTurnId: identity.fillTurnId, approvalId: identity.receiptId, receiptId: identity.receiptId,
        constraintHash: identity.constraintHash, workerTaskId: identity.workerTaskId },
    } });
    await tx.agentOutbox.create({ data: { ...intent, payload: intent.payload as unknown as Prisma.InputJsonObject } });
    await tx.activity.create({ data: { userId: input.userId, jobId: input.jobId, type: "agent_action",
      text: "Agent queued this application after explicit per-job user authorization.", color: "#7C3AED" } });
    return identity.workerTaskId;
  });
  if (!taskId) throw new AutoApplyError("This application is no longer ready for the approved submission step.");
  return { taskId };
}
