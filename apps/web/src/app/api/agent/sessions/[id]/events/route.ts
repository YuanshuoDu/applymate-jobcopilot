import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

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
    createdAt: event.createdAt.toISOString(),
  }
}

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await ctx.params
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
