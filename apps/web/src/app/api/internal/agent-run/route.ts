import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { err, ok } from "@/lib/api-helpers";
import { APPLYMATE_BACKING, loadUserAiConfig, resolveConfig } from "@/lib/model-router";
import { runAgentPipeline } from "@/lib/agent/run-service";
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
  if (typeof row.userId !== "string" || typeof row.sessionId !== "string" || row.userId.length === 0 || row.sessionId.length === 0) return null;
  return {
    canonical,
    input: {
      userId: row.userId,
      sessionId: row.sessionId,
      ...(typeof row.turnId === "string" ? { turnId: row.turnId } : {}),
      ...(typeof row.executionId === "string" ? { executionId: row.executionId } : {}),
    },
  };
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
  if (account?.accountStatus !== "active") return err("Account unavailable", 403);

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

  if (!(await isFeatureAllowed(input.userId, "auto_apply"))) return err("This feature is not included in your current plan", 403);
  const aiAccess = await resolveAiAccess(input.userId);
  if (aiAccess === "disabled") return err("This feature is not included in your current plan", 403);
  if (aiAccess === "exhausted") return err("Monthly AI credits exhausted", 429);

  const execution = canonical && input.executionId
    ? await db.agentExecution.findFirst({
        where: { id: input.executionId, userId: input.userId, sessionId: session.id },
        select: { id: true, state: true, userId: true, sessionId: true },
      })
    : await db.agentExecution.findFirst({
        where: { userId: input.userId, sessionId: session.id },
        select: { state: true },
      });
  if (canonical && input.executionId && (
    !execution ||
    !("userId" in execution) ||
    !("sessionId" in execution) ||
    execution.userId !== input.userId ||
    execution.sessionId !== session.id
  )) {
    return canonicalError("canonical_execution_not_owned", "Canonical execution is not owned by this user and session", 404);
  }
  const state = execution?.state
  const autonomous = Boolean(state && typeof state === "object" && !Array.isArray(state) && (state as { autonomous?: unknown }).autonomous === true)
  if (autonomous && !await hasEffectiveEntitlement(input.userId, 'auto_apply')) return err("Your current plan does not include autonomous applications.", 403)

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
    executionId: input.executionId,
    signal: req.signal,
  });

  return ok({ status: report ? "completed" : "failed", report });
}
