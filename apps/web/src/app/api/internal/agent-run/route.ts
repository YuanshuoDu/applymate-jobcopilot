import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, ok } from "@/lib/api-helpers";
import { APPLYMATE_BACKING, loadUserAiConfig, resolveConfig } from "@/lib/model-router";
import { runAgentPipeline } from "@/lib/agent/run-service";

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
    where: { id: input.sessionId, userId: input.userId, source: "automation" },
    select: { id: true },
  });
  if (!session) return err("Automation session not found", 404);

  const configured = await loadUserAiConfig(input.userId, "autoApply");
  const aiConfig = configured.resolvedKey ? configured : resolveConfig(APPLYMATE_BACKING);
  const report = await runAgentPipeline({
    userId: input.userId,
    sessionId: session.id,
    aiConfig,
    autonomous: true,
  });

  return ok({ status: report ? "completed" : "failed", report });
}
