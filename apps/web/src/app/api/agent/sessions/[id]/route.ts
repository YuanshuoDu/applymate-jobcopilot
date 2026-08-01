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
  applicationTasks: Array<{
    id: string
    status: string
    checkpoint: string | null
    error: string | null
    question: unknown | null
    job: { company: string; role: string }
  }>
  execution: { id: string; status: string; checkpoint: string; error: string | null; attemptCount: number } | null
  questions: Array<{ id: string; stage: string; question: string; options: unknown }>
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
    applicationTasks: session.applicationTasks,
    execution: session.execution,
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
      applicationTasks: {
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: { id: true, status: true, checkpoint: true, error: true, question: true, job: { select: { company: true, role: true } } },
      },
      execution: { select: { id: true, status: true, checkpoint: true, error: true, attemptCount: true } },
    },
  })

  if (!session) return err("Session not found", 404)
  const questions = await db.agentRunQuestion.findMany({
    where: { userId: auth.userId, runId: id, answer: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, stage: true, question: true, options: true },
  })
  return ok({ session: serializeSession({ ...session, questions }) })
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
