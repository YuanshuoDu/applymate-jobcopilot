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
import { AgentWaitError } from '@/lib/agent/broker/errors'
import { answerLegacyQuestion, type LegacyQuestionAnswerResult } from '@/lib/agent/broker/legacy-question-answer'

const CANONICAL_WAIT_CODE = 'canonical_turn_owns_wait'
const BRIDGE_PENDING_CODE = 'legacy_question_bridge_pending'
const LEGACY_TURN_QUESTION_ID = /^agent-question:[^:]+:legacy:[^:]+$/

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

  if (bridgeResult.disposition === 'legacy_dispatch_accepted') {
    return ok({
      accepted: true,
      answered: true,
      questionId: bridgeResult.questionId,
      answer: body.answer.trim(),
      resumed: false,
      disposition: bridgeResult.disposition,
      dispatchStatus: 'pending',
      turnId: bridgeResult.turnId,
      dispatchIntentId: bridgeResult.outboxId,
      dispatchIdempotencyKey: bridgeResult.idempotencyKey,
    }, 202)
  }

  if (bridgeResult.disposition === 'legacy_dispatch_pending') {
    return ok({
      accepted: true,
      answered: true,
      questionId: bridgeResult.questionId,
      answer: body.answer.trim(),
      resumed: false,
      disposition: bridgeResult.disposition,
      dispatchStatus: 'pending',
      turnId: bridgeResult.turnId,
      dispatchIntentId: bridgeResult.outboxId,
      dispatchIdempotencyKey: bridgeResult.idempotencyKey,
    }, 202)
  }

  if (bridgeResult.disposition === 'legacy_dispatch_conflict') {
    return Response.json({
      error: 'The execution is queued without a matching durable dispatch intent.',
      code: 'dispatch_intent_conflict',
      questionId: bridgeResult.questionId,
      resumed: false,
    }, { status: 503 })
  }

  if (bridgeResult.disposition === 'legacy_already_resuming') {
    return ok({
      answered: true,
      questionId: bridgeResult.questionId,
      answer: body.answer.trim(),
      resumed: true,
      disposition: bridgeResult.disposition,
      turnId: bridgeResult.turnId,
    })
  }
  if (bridgeResult.disposition === 'legacy_answered') {
    return ok({
      answered: true,
      questionId: bridgeResult.questionId,
      answer: bridgeResult.answer,
      resumed: false,
      disposition: bridgeResult.disposition,
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
  if (bridgeResult.disposition === 'legacy_only' && bridgeResult.reason === 'session_unmapped') {
    return Response.json({ error: 'This question has no current session owner.', code: 'legacy_question_session_unmapped' }, { status: 409 })
  }
  if (bridgeResult.disposition === 'legacy_only' && bridgeResult.reason === 'active_turn_owns_wait') {
    return Response.json({ error: 'A canonical agent turn owns this wait.', code: CANONICAL_WAIT_CODE }, { status: 409 })
  }
  if (bridgeResult.disposition === 'legacy_only' && bridgeResult.reason === 'turn_not_waiting' && LEGACY_TURN_QUESTION_ID.test(body.questionId)) {
    return Response.json({ error: 'This Turn question is no longer waiting.', code: 'legacy_question_turn_not_waiting' }, { status: 409 })
  }
  if (bridgeResult.disposition === 'legacy_only') {
    return Response.json({ error: 'This question is no longer waiting.', code: 'legacy_question_not_waiting' }, { status: 409 })
  }
  return Response.json({ error: 'Could not answer the Agent.', code: 'answer_bridge_failed' }, { status: 503 })
}
