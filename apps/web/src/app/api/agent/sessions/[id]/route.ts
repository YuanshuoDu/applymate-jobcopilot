import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

interface RouteCtx {
  params: Promise<{ id: string }>
}

function iso(date: Date | null) {
  return date?.toISOString() ?? null
}

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
  tasks: Array<{
    id: string
    role: string
    taskType: string
    status: string
    confidence: number | null
    failureReason: string | null
    createdAt: Date
    updatedAt: Date
  }>
  approvals: Array<{
    id: string
    type: string
    status: string
    title: string
    createdAt: Date
  }>
}) {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    completedAt: iso(session.completedAt),
    tasks: session.tasks.map(task => ({
      ...task,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    })),
    approvals: session.approvals.map(approval => ({
      ...approval,
      createdAt: approval.createdAt.toISOString(),
    })),
  }
}

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await ctx.params
  const session = await db.agentSession.findFirst({
    where: { id, userId: auth.userId },
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
      tasks: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          taskType: true,
          status: true,
          confidence: true,
          failureReason: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      approvals: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          status: true,
          title: true,
          createdAt: true,
        },
      },
    },
  })

  if (!session) return err("Session not found", 404)
  return ok({ session: serializeSession(session) })
}

export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await ctx.params
  const result = await db.agentSession.deleteMany({
    where: { id, userId: auth.userId },
  })
  if (result.count === 0) return err("Session not found", 404)

  return new Response(null, { status: 204 })
}
