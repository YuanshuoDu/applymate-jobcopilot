import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { legacyTranscriptData } from "@/lib/agent/session/transcript-projector"
import { createV2EventStream, parseAfterSequence } from "@/lib/agent/session/v2-event-stream"
import { isRuntimeAgentHarnessFeatureEnabled } from "@/lib/runtime-feature-flags"

interface RouteCtx {
  params: Promise<{ id: string }>
}

function serializeEvent(event: {
  id: string
  taskId: string | null
  type: string
  speaker: string
  title: string | null
  body: string
  data: unknown
  durationMs: number | null
  createdAt: Date
}) {
  return {
    ...event,
    data: legacyTranscriptData(event.data),
    createdAt: event.createdAt.toISOString(),
  }
}

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await ctx.params
  const v2Enabled = await isRuntimeAgentHarnessFeatureEnabled("AGENT_EVENT_SSE_V2", auth.userId)
  if (v2Enabled) return getV2Events(req, id, auth.userId)

  const session = await db.agentSession.findFirst({
    where: { id, userId: auth.userId },
    select: { id: true },
  })

  if (!session) return err("Session not found", 404)

  const events = await db.agentTranscriptEvent.findMany({
    where: { sessionId: id },
    orderBy: { createdAt: "asc" },
    take: 500,
    select: {
      id: true,
      taskId: true,
      type: true,
      speaker: true,
      title: true,
      body: true,
      data: true,
      durationMs: true,
      createdAt: true,
    },
  })

  return ok({ events: events.map(serializeEvent) })
}

async function getV2Events(req: NextRequest, id: string, userId: string): Promise<Response> {
  const afterSequence = parseAfterSequence(req)
  if (afterSequence instanceof Response) return afterSequence

  const session = await db.agentSession.findFirst({
    where: { id, userId },
    select: { id: true },
  })
  if (!session) return err("Session not found", 404)

  return new Response(createV2EventStream(db, {
    sessionId: id,
    afterSequence,
    signal: req.signal,
  }), {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  })
}
