import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { createAgentSession } from "@/lib/agent/session/repository"

const STALE_CHAT_SESSION_MS = 30 * 60 * 1000

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

  const completedAt = new Date()
  await db.agentSession.updateMany({
    where: {
      userId: auth.userId,
      source: "chat",
      status: "running",
      updatedAt: { lt: new Date(completedAt.getTime() - STALE_CHAT_SESSION_MS) },
      approvals: { none: { status: "pending" } },
      tasks: { none: { status: { in: ["queued", "running", "retrying", "waiting_for_user"] } } },
    },
    data: { status: "completed", completedAt },
  })

  const [sessions, lastOpenedSession] = await Promise.all([
    db.agentSession.findMany({
      where: { userId: auth.userId },
      orderBy: { updatedAt: "desc" },
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
    }),
    db.agentSession.findFirst({
      where: { userId: auth.userId, lastViewedAt: { not: null } },
      orderBy: { lastViewedAt: "desc" },
      select: { id: true },
    }),
  ])

  return ok({
    sessions: sessions.map(serializeSession),
    // Existing accounts created before this column was introduced should still
    // resume the most recent conversation instead of opening a blank page.
    lastOpenedSessionId: lastOpenedSession?.id ?? sessions[0]?.id ?? null,
  })
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
