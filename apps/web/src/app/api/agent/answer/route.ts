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

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body?.questionId || !body?.answer) return err('Missing questionId or answer')

  const q = await db.agentRunQuestion.findFirst({
    where: { id: body.questionId, userId: auth.userId },
  })
  if (!q) return err('Question not found', 404)
  if (q.answer) return err('Already answered', 409)

  await db.agentRunQuestion.update({
    where: { id: body.questionId },
    data:  { answer: body.answer, answeredAt: new Date() },
  })

  return ok({ answered: true, questionId: body.questionId, answer: body.answer })
}
