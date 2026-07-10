import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { createAgentSession } from "@/lib/agent/session/repository"

function serializeSession(session: {
  id: string
  goal: string
  status: string
  source: string
  memorySummary: string
  qualityScore: number | null
  currentTaskId: string | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}) {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
  }
}

function readGoal(body: unknown) {
  if (!body || typeof body !== "object") return ""
  const goal = (body as { goal?: unknown }).goal
  return typeof goal === "string" ? goal.trim() : ""
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const sessions = await db.agentSession.findMany({
    where: { userId: auth.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      goal: true,
      status: true,
      source: true,
      memorySummary: true,
      qualityScore: true,
      currentTaskId: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
    },
  })

  return ok({ sessions: sessions.map(serializeSession) })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const goal = readGoal(await req.json().catch(() => null))
  if (!goal) return err("Session goal is required", 400)

  const session = await createAgentSession(db, {
    userId: auth.userId,
    goal,
    source: "chat",
  })
  const sessionRow = session as Parameters<typeof serializeSession>[0]

  return ok({ session: serializeSession(sessionRow) }, 201)
}
