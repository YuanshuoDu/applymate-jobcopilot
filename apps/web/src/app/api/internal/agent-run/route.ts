import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { err, ok } from "@/lib/api-helpers";
import { APPLYMATE_BACKING, loadUserAiConfig, resolveConfig } from "@/lib/model-router";
import { runAgentPipeline } from "@/lib/agent/run-service";
import { failLegacyTurnBeforeRun, isStaleExactWorkerAttempt } from "@/lib/agent/execution-control";
import { hasEffectiveEntitlement, isFeatureAllowed, resolveAiAccess } from '@/lib/entitlements'

export const maxDuration = 300;

function authorized(req: NextRequest) {
  const secret = process.env.AGENT_WORKER_SECRET;
  return Boolean(secret) && req.headers.get("x-agent-worker-secret") === secret;
}

type AgentRunInput = {
  userId: string;
  sessionId: string;
  turnId?: string;
  executionId?: string;
  legacyTurnId?: string;
  questionId?: string;
  workerTaskId?: string;
  expectedAttemptCount?: number;
};

type ParsedTask = { input: AgentRunInput; canonical: boolean } | { error: Response } | null;

function canonicalError(code: string, message: string, status: 400 | 404 | 409): NextResponse {
  return NextResponse.json({ error: { code, message, details: {} } }, { status });
}

function taskInput(value: unknown): ParsedTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const canonical = row.turnId !== undefined;
  if (canonical && (typeof row.turnId !== "string" || row.turnId.length === 0)) {
    return { error: canonicalError("canonical_identity_required", "Canonical turn identity is required", 400) };
  }
  if (canonical && (typeof row.userId !== "string" || typeof row.sessionId !== "string" || row.userId.length === 0 || row.sessionId.length === 0)) {
    return { error: canonicalError("canonical_identity_required", "Canonical user and session identity are required", 400) };
  }
  if (row.executionId !== undefined && (typeof row.executionId !== "string" || row.executionId.length === 0)) {
    return canonical
      ? { error: canonicalError("canonical_execution_invalid", "Canonical execution identity is invalid", 400) }
      : null;
  }
  if (row.legacyTurnId !== undefined && (typeof row.legacyTurnId !== "string" || row.legacyTurnId.length === 0)) return null;
  if (row.questionId !== undefined && (typeof row.questionId !== "string" || row.questionId.length === 0)) return null;
  if (row.workerTaskId !== undefined && (typeof row.workerTaskId !== "string" || row.workerTaskId.length === 0)) return null;
  if (row.expectedAttemptCount !== undefined && (!Number.isSafeInteger(row.expectedAttemptCount) || Number(row.expectedAttemptCount) < 0)) return null;
  if (typeof row.userId !== "string" || typeof row.sessionId !== "string" || row.userId.length === 0 || row.sessionId.length === 0) return null;
  if (!canonical && row.executionId !== undefined && typeof row.questionId === "string"
    && row.questionId.startsWith("agent-question:") && row.legacyTurnId === undefined) {
    return { error: canonicalError("legacy_dispatch_turn_required", "Namespaced legacy questions require their exact Turn identity", 400) };
  }
  if (row.legacyTurnId !== undefined && (canonical || !row.executionId || !row.questionId
    || !row.workerTaskId || row.expectedAttemptCount === undefined
    || !(row.questionId as string).startsWith(`agent-question:${row.legacyTurnId}:legacy:`))) {
    return { error: canonicalError("legacy_dispatch_identity_invalid", "Legacy Turn dispatch identity is invalid", 400) };
  }
  if (!canonical && row.executionId !== undefined && (!row.questionId || !row.workerTaskId || row.expectedAttemptCount === undefined)) {
    return { error: canonicalError("worker_dispatch_identity_required", "Exact worker task and attempt identity are required", 400) };
  }
  return {
    canonical,
    input: {
      userId: row.userId,
      sessionId: row.sessionId,
      ...(typeof row.turnId === "string" ? { turnId: row.turnId } : {}),
      ...(typeof row.executionId === "string" ? { executionId: row.executionId } : {}),
      ...(typeof row.legacyTurnId === "string" ? { legacyTurnId: row.legacyTurnId } : {}),
      ...(typeof row.questionId === "string" ? { questionId: row.questionId } : {}),
      ...(typeof row.workerTaskId === "string" ? { workerTaskId: row.workerTaskId } : {}),
      ...(typeof row.expectedAttemptCount === "number" ? { expectedAttemptCount: row.expectedAttemptCount } : {}),
    },
  };
}

async function terminalPreflight(input: AgentRunInput, message: string, status: 403 | 429 = 403) {
  if (input.legacyTurnId && input.executionId && input.questionId && input.workerTaskId && input.expectedAttemptCount !== undefined) {
    try {
      await failLegacyTurnBeforeRun({
        userId: input.userId, sessionId: input.sessionId, executionId: input.executionId,
        workerTaskId: input.workerTaskId, expectedAttemptCount: input.expectedAttemptCount,
        turnId: input.legacyTurnId, questionId: input.questionId, message,
      })
    } catch (error) {
      console.error("Failed to close rejected legacy agent Turn", error)
      return err("Unable to persist the rejected agent Turn outcome", 500)
    }
  }
  return err(message, status)
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return err("Unauthorized", 401);

  const parsed = taskInput(await req.json().catch(() => null));
  if (!parsed) return err("Invalid agent run task", 400);
  if ("error" in parsed) return parsed.error;
  const { input, canonical } = parsed;

  const account = await db.user.findUnique({
    where: { id: input.userId },
    select: { accountStatus: true },
  });
  if (account?.accountStatus !== "active") return terminalPreflight(input, "Account unavailable");

  const session = await db.agentSession.findFirst({
    // A user can begin in the interactive Agent UI and later answer a durable
    // question after the original SSE request has ended. The worker is already
    // authenticated with a server secret, so any owned Agent session is safe
    // to resume here; authorization still happens at session/question level.
    where: { id: input.sessionId, userId: input.userId },
    select: { id: true },
  });
  if (!session) {
    return canonical
      ? canonicalError("canonical_identity_mismatch", "Canonical session identity does not match the user", 404)
      : err("Agent session not found", 404);
  }

  if (canonical) {
    const turn = await db.agentTurn.findFirst({
      where: { id: input.turnId, sessionId: session.id, userId: input.userId },
      select: { id: true, status: true, userId: true, sessionId: true },
    });
    if (!turn || turn.userId !== input.userId || turn.sessionId !== session.id) {
      return canonicalError("canonical_turn_not_owned", "Canonical Turn is not owned by this user and session", 404);
    }
    if (!["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(turn.status)) {
      return canonicalError("canonical_turn_not_active", "The requested canonical Turn is not active", 409);
    }
  }

  if (!(await isFeatureAllowed(input.userId, "auto_apply"))) return terminalPreflight(input, "This feature is not included in your current plan");
  const aiAccess = await resolveAiAccess(input.userId);
  if (aiAccess === "disabled") return terminalPreflight(input, "This feature is not included in your current plan");
  if (aiAccess === "exhausted") return terminalPreflight(input, "Monthly AI credits exhausted", 429);

  const execution = input.executionId
    ? await db.agentExecution.findFirst({
        where: { id: input.executionId, userId: input.userId, sessionId: session.id },
        select: canonical
          ? { id: true, state: true, userId: true, sessionId: true }
          : { id: true, state: true, userId: true, sessionId: true, status: true, attemptCount: true, workerTaskId: true, updatedAt: true },
      })
    : await db.agentExecution.findFirst({
        where: { userId: input.userId, sessionId: session.id },
        select: { state: true },
      });
  if (input.executionId && (
    !execution ||
    !("userId" in execution) ||
    !("sessionId" in execution) ||
    execution.userId !== input.userId ||
    execution.sessionId !== session.id
  )) {
    return canonical
      ? canonicalError("canonical_execution_not_owned", "Canonical execution is not owned by this user and session", 404)
      : err("Agent execution not found", 404);
  }
  if (!canonical && input.executionId && input.workerTaskId && input.expectedAttemptCount !== undefined) {
    const exactExecution = execution && "status" in execution && typeof execution.status === "string"
      && "attemptCount" in execution && typeof execution.attemptCount === "number"
      && "workerTaskId" in execution && (typeof execution.workerTaskId === "string" || execution.workerTaskId === null)
      && "updatedAt" in execution && (execution.updatedAt instanceof Date || typeof execution.updatedAt === "string")
      ? {
          status: execution.status,
          attemptCount: execution.attemptCount,
          workerTaskId: execution.workerTaskId,
          updatedAt: execution.updatedAt,
        }
      : null
    const queuedExact = exactExecution?.status === "queued"
      && exactExecution.attemptCount === input.expectedAttemptCount
      && exactExecution.workerTaskId === input.workerTaskId
    const staleExact = exactExecution !== null && isStaleExactWorkerAttempt(exactExecution,
      input.expectedAttemptCount, input.workerTaskId)
    if (!queuedExact && !staleExact) return err("Agent execution dispatch is no longer current", 409)
  }
  const state = execution?.state
  const autonomous = Boolean(state && typeof state === "object" && !Array.isArray(state) && (state as { autonomous?: unknown }).autonomous === true)
  if (autonomous && !await hasEffectiveEntitlement(input.userId, 'auto_apply')) return terminalPreflight(input, "Your current plan does not include autonomous applications.")

  const configured = await loadUserAiConfig(input.userId, "autoApply");
  const aiConfig = configured.resolvedKey
    ? {
        ...configured,
        usageUserId: input.userId,
        usageFeatureKey: "autoApply",
        usageRuntime: "worker" as const,
      }
    : {
        ...resolveConfig(APPLYMATE_BACKING),
        usageUserId: input.userId,
        usageFeatureKey: "autoApply",
        usageRuntime: "worker" as const,
      };
  const report = await runAgentPipeline({
    userId: input.userId,
    sessionId: session.id,
    source: "automation",
    aiConfig,
    autonomous,
    turnId: input.turnId,
    legacyTurnId: input.legacyTurnId,
    questionId: input.questionId,
    workerTaskId: input.workerTaskId,
    expectedAttemptCount: input.expectedAttemptCount,
    executionId: input.executionId,
    signal: req.signal,
  });

  return ok({ status: report ? "completed" : "failed", report });
}
