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
import { AgentWaitError } from '@/lib/agent/broker/errors'
import { answerLegacyQuestion, type LegacyQuestionAnswerResult } from '@/lib/agent/broker/legacy-question-answer'

const ACTIVE_CANONICAL_TURN_STATUSES = [
  'queued',
  'in_progress',
  'waiting_for_dependency',
  'waiting_for_approval',
  'waiting_for_user',
] as const

const CANONICAL_WAIT_CODE = 'canonical_turn_owns_wait'
const BRIDGE_PENDING_CODE = 'legacy_question_bridge_pending'
const DISPATCH_PENDING_CODE = 'dispatch_pending'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (typeof body?.questionId !== 'string' || typeof body?.answer !== 'string' || !body.answer.trim()) return err('Missing questionId or answer')

  let bridgeResult: LegacyQuestionAnswerResult
  try {
    bridgeResult = await answerLegacyQuestion(db, {
      questionId: body.questionId,
      userId: auth.userId,
      answer: body.answer,
      ...(typeof body.clientMessageId === 'string' ? { clientMessageId: body.clientMessageId } : {}),
    })
  } catch (error) {
    if (error instanceof AgentWaitError) {
      return Response.json({ error: error.message, code: error.code, details: error.details }, { status: error.status })
    }
    return Response.json({ error: error instanceof Error ? error.message : 'Could not answer the Agent', code: 'answer_bridge_failed' }, { status: 503 })
  }

  if (bridgeResult.disposition === 'bridged' || bridgeResult.disposition === 'duplicate') {
    return ok({
      answered: true,
      questionId: bridgeResult.questionId,
      answer: body.answer,
      resumed: false,
      continuation: 'canonical_turn_wakeup_recorded',
      disposition: bridgeResult.disposition,
      turnId: bridgeResult.turnId,
      itemId: bridgeResult.itemId,
      nextTurnRevision: bridgeResult.nextTurnRevision,
    })
  }

  if (bridgeResult.disposition === 'bridge_pending') {
    return Response.json({
      error: 'The canonical question bridge is pending proof.',
      code: BRIDGE_PENDING_CODE,
      reason: bridgeResult.reason,
    }, { status: 409 })
  }

  if (bridgeResult.disposition === 'legacy_only' && bridgeResult.reason === 'question_not_found') return err('Question not found', 404)

  const q = await db.agentRunQuestion.findFirst({
    where: { id: body.questionId, userId: auth.userId },
  })
  if (!q) return err('Question not found', 404)

  const canonicalTurn = await db.agentTurn.findFirst({
    where: {
      sessionId: q.runId,
      userId: auth.userId,
      status: { in: [...ACTIVE_CANONICAL_TURN_STATUSES] },
    },
    select: { id: true },
  })
  if (canonicalTurn) {
    return Response.json({
      error: 'A canonical agent turn owns this wait.',
      code: CANONICAL_WAIT_CODE,
    }, { status: 409 })
  }

  if (q.answer) return err('Already answered', 409)
  const validAnswers = Array.isArray(q.options)
    ? q.options.flatMap(option => option && typeof option === 'object' && typeof (option as { value?: unknown }).value === 'string'
      ? [(option as { value: string }).value]
      : [])
    : []
  if (validAnswers.length > 0 && !validAnswers.includes(body.answer)) return err('Answer is not one of the offered options', 400)

  const questionClaim = await db.agentRunQuestion.updateMany({
    where: { id: body.questionId, userId: auth.userId, answer: null },
    data: { answer: body.answer, answeredAt: new Date() },
  })
  if (questionClaim.count !== 1) return err('Already answered', 409)

  const execution = await db.agentExecution.findFirst({
    where: { userId: auth.userId, sessionId: q.runId, status: "waiting_for_user" },
    select: { id: true, sessionId: true },
  })
  if (execution) {
    try {
      // Make the state claimable before putting the BullMQ message on Redis.
      // Otherwise a fast worker could see waiting_for_user and drop the job.
      const executionClaim = await db.agentExecution.updateMany({
        where: { id: execution.id, userId: auth.userId, status: "waiting_for_user" },
        data: { status: "queued", error: null, completedAt: null },
      })
      if (executionClaim.count !== 1) return ok({ answered: true, questionId: body.questionId, answer: body.answer, resumed: false })
      const taskId = await enqueueAgentRun({ userId: auth.userId, sessionId: execution.sessionId })
      await db.agentExecution.update({
        where: { id: execution.id },
        data: { workerTaskId: taskId },
      })
    } catch (error) {
      await db.agentRunQuestion.updateMany({
        where: { id: q.id, userId: auth.userId, answer: body.answer },
        data: { answer: null, answeredAt: null },
      }).catch(() => undefined)
      await db.agentExecution.updateMany({
        where: { id: execution.id, userId: auth.userId, status: "queued" },
        data: { status: "waiting_for_user" },
      }).catch(() => undefined)
      return Response.json({
        error: error instanceof Error ? error.message : "Could not resume the Agent",
        code: DISPATCH_PENDING_CODE,
        questionId: body.questionId,
        resumed: false,
      }, { status: 503 })
    }
  }

  return ok({ answered: true, questionId: body.questionId, answer: body.answer, resumed: Boolean(execution) })
}
