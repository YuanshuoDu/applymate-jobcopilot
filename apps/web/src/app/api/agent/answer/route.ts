/**
 * POST /api/agent/answer
 * User answers a pending Orchestrator question.
 * Body: { questionId, answer }
 *
 * The running pipeline polls for this answer via pollForAnswer() in orchestrator.ts.
 */
import { NextRequest }                          from 'next/server'
import { db }                                    from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { enqueueAgentRun } from '@/lib/agent-run-queue-client'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (typeof body?.questionId !== 'string' || typeof body?.answer !== 'string' || !body.answer.trim()) return err('Missing questionId or answer')

  const q = await db.agentRunQuestion.findFirst({
    where: { id: body.questionId, userId: auth.userId },
  })
  if (!q) return err('Question not found', 404)
  if (q.answer) return err('Already answered', 409)
  const validAnswers = Array.isArray(q.options)
    ? q.options.flatMap(option => option && typeof option === 'object' && typeof (option as { value?: unknown }).value === 'string'
      ? [(option as { value: string }).value]
      : [])
    : []
  if (validAnswers.length > 0 && !validAnswers.includes(body.answer)) return err('Answer is not one of the offered options', 400)

  await db.agentRunQuestion.update({
    where: { id: body.questionId },
    data:  { answer: body.answer, answeredAt: new Date() },
  })

  const execution = await db.agentExecution.findFirst({
    where: { userId: auth.userId, sessionId: q.runId, status: "waiting_for_user" },
    select: { id: true, sessionId: true },
  })
  if (execution) {
    try {
      // Make the state claimable before putting the BullMQ message on Redis.
      // Otherwise a fast worker could see waiting_for_user and drop the job.
      await db.agentExecution.update({
        where: { id: execution.id },
        data: { status: "queued", error: null, completedAt: null },
      })
      const taskId = await enqueueAgentRun({ userId: auth.userId, sessionId: execution.sessionId })
      await db.agentExecution.update({
        where: { id: execution.id },
        data: { workerTaskId: taskId },
      })
    } catch (error) {
      await db.agentRunQuestion.update({ where: { id: q.id }, data: { answer: null, answeredAt: null } }).catch(() => undefined)
      await db.agentExecution.update({ where: { id: execution.id }, data: { status: "waiting_for_user" } }).catch(() => undefined)
      return err(error instanceof Error ? error.message : "Could not resume the Agent", 503)
    }
  }

  return ok({ answered: true, questionId: body.questionId, answer: body.answer, resumed: Boolean(execution) })
}
