import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, ok } from "@/lib/api-helpers";
import { APPLYMATE_BACKING, loadUserAiConfig, resolveConfig } from "@/lib/model-router";
import { runAgentPipeline } from "@/lib/agent/run-service";
import { isFeatureAllowed, resolveAiAccess } from "@/lib/entitlements";

export const maxDuration = 300;

function authorized(req: NextRequest) {
  const secret = process.env.AGENT_WORKER_SECRET;
  return Boolean(secret) && req.headers.get("x-agent-worker-secret") === secret;
}

function taskInput(value: unknown): { userId: string; sessionId: string } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return typeof row.userId === "string" && typeof row.sessionId === "string"
    && row.userId.length > 0 && row.sessionId.length > 0
    ? { userId: row.userId, sessionId: row.sessionId }
    : null;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return err("Unauthorized", 401);

  const input = taskInput(await req.json().catch(() => null));
  if (!input) return err("Invalid agent run task", 400);

  const session = await db.agentSession.findFirst({
    // A user can begin in the interactive Agent UI and later answer a durable
    // question after the original SSE request has ended. The worker is already
    // authenticated with a server secret, so any owned Agent session is safe
    // to resume here; authorization still happens at session/question level.
    where: { id: input.sessionId, userId: input.userId },
    select: { id: true },
  });
  if (!session) return err("Agent session not found", 404);
  if (!(await isFeatureAllowed(input.userId, "auto_apply"))) return err("This feature is not included in your current plan", 403);
  const aiAccess = await resolveAiAccess(input.userId);
  if (aiAccess === "disabled") return err("This feature is not included in your current plan", 403);
  if (aiAccess === "exhausted") return err("Monthly AI credits exhausted", 429);

  const execution = await db.agentExecution.findFirst({
    where: { userId: input.userId, sessionId: session.id },
    select: { state: true },
  });
  const state = execution?.state
  const autonomous = Boolean(state && typeof state === "object" && !Array.isArray(state) && (state as { autonomous?: unknown }).autonomous === true)

  const configured = await loadUserAiConfig(input.userId, "autoApply");
  const aiConfig = configured.resolvedKey ? configured : resolveConfig(APPLYMATE_BACKING);
  const report = await runAgentPipeline({
    userId: input.userId,
    sessionId: session.id,
    aiConfig,
    autonomous,
  });

  return ok({ status: report ? "completed" : "failed", report });
}
