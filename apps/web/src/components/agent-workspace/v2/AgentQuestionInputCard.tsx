'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'

import { createAgentQuestionMessageId, isCurrentAgentQuestionRequest, postAgentQuestionAnswer, type QuestionActionResult } from './question-action'
import { parseQuestionInputItem, type QuestionInputOption, type QuestionInputProjection, type QuestionInputStatus } from './question-input-parser'
import type { TimelineItem } from './timeline-reducer'
import type { SupervisorTurnSummary } from './task-tree-projection'

export interface AgentQuestionInputCardProps {
  readonly sessionId: string
  readonly items: readonly TimelineItem[]
  readonly turns: readonly SupervisorTurnSummary[]
  readonly onAccepted: () => void
  readonly selectionKey?: string
}

type Feedback = 'accepted' | 'duplicate' | 'failed'
type StringById = Record<string, string>
type BooleanById = Record<string, boolean>
type FeedbackById = Record<string, Feedback | undefined>

const STATUS_KEYS: Record<Exclude<QuestionInputStatus, 'pending'>, string> = {
  answered: 'agent.question.status.answered', cancelled: 'agent.question.status.cancelled',
}

/** Renders canonical question waits and sends answers through the Broker only. */
export function AgentQuestionInputCard({ sessionId, items, turns, onAccepted, selectionKey: externalSelectionKey = '' }: AgentQuestionInputCardProps) {
  const { t } = useI18n()
  const [answers, setAnswers] = useState<StringById>({})
  const [submitting, setSubmitting] = useState<BooleanById>({})
  const [feedback, setFeedback] = useState<FeedbackById>({})
  const requestEpochRef = useRef(0)
  const previousSelectionKeyRef = useRef('')
  const submittingKeysRef = useRef(new Set<string>())
  const questions = useMemo(() => uniqueQuestions(items, sessionId), [items, sessionId])
  const selectionKey = `${sessionId}:${externalSelectionKey}:${questions.map(question => `${question.questionId}:${question.turnId}:${question.status}:${question.revision}`).join(',')}`

  // Advance during render so a late response cannot win a new session, selection, or item revision.
  if (previousSelectionKeyRef.current !== selectionKey) {
    previousSelectionKeyRef.current = selectionKey
    requestEpochRef.current += 1
  }

  useEffect(() => {
    setAnswers({})
    setSubmitting({})
    setFeedback({})
  }, [selectionKey])

  const handleAnswer = useCallback((question: QuestionInputProjection, answer: string, expectedRevision: number) => {
    const normalizedAnswer = answer.trim()
    if (!normalizedAnswer) return
    const requestKey = `${sessionId}:${question.questionId}:${question.turnId}:${expectedRevision}`
    if (submittingKeysRef.current.has(requestKey)) return
    submittingKeysRef.current.add(requestKey)
    const requestEpoch = requestEpochRef.current
    const requestSelectionKey = selectionKey
    const clientMessageId = createAgentQuestionMessageId()
    setSubmitting(current => ({ ...current, [question.questionId]: true }))
    setFeedback(current => ({ ...current, [question.questionId]: undefined }))
    void postAgentQuestionAnswer({ sessionId, questionId: question.questionId, expectedTurnId: question.turnId, expectedRevision, answer: normalizedAnswer, clientMessageId }).then((result: QuestionActionResult) => {
      if (!isCurrentAgentQuestionRequest(requestEpochRef.current, requestEpoch, selectionKey, requestSelectionKey)) return
      setFeedback(current => ({ ...current, [question.questionId]: result.disposition === 'duplicate' ? 'duplicate' : 'accepted' }))
      onAccepted()
    }).catch(() => {
      if (isCurrentAgentQuestionRequest(requestEpochRef.current, requestEpoch, selectionKey, requestSelectionKey)) setFeedback(current => ({ ...current, [question.questionId]: 'failed' }))
    }).finally(() => {
      submittingKeysRef.current.delete(requestKey)
      if (isCurrentAgentQuestionRequest(requestEpochRef.current, requestEpoch, selectionKey, requestSelectionKey)) setSubmitting(current => ({ ...current, [question.questionId]: false }))
    })
  }, [onAccepted, selectionKey, sessionId])

  if (questions.length === 0) return null
  return (
    <section data-agent-question-card="true" aria-label={t('agent.question.title')} style={cardStyle}>
      <div style={headingStyle}><strong>{t('agent.question.title')}</strong><span style={mutedStyle}>{t('agent.question.serverOwned')}</span></div>
      <div style={rowsStyle}>
        {questions.map(question => <QuestionRow key={question.questionId} question={question} sessionId={sessionId} turns={turns} answer={answers[question.questionId] ?? ''} submitting={Boolean(submitting[question.questionId])} feedback={feedback[question.questionId]} onOption={(option: QuestionInputOption) => setAnswers(current => ({ ...current, [question.questionId]: option.value }))} onText={(answer: string) => setAnswers(current => ({ ...current, [question.questionId]: answer }))} onAnswer={handleAnswer} t={t} />)}
      </div>
    </section>
  )
}

function QuestionRow({ question, sessionId, turns, answer, submitting, feedback, onOption, onText, onAnswer, t }: {
  readonly question: QuestionInputProjection
  readonly sessionId: string
  readonly turns: readonly SupervisorTurnSummary[]
  readonly answer: string
  readonly submitting: boolean
  readonly feedback: Feedback | undefined
  readonly onOption: (option: QuestionInputOption) => void
  readonly onText: (answer: string) => void
  readonly onAnswer: (question: QuestionInputProjection, answer: string, expectedRevision: number) => void
  readonly t: (key: string) => string
}) {
  const expectedRevision = turnRevision(turns, sessionId, question.turnId)
  if (question.status !== 'pending') return <div data-agent-question-row="true" style={rowStyle}><p style={questionStyle}>{question.question}</p><span style={mutedStyle}>{t(STATUS_KEYS[question.status])}</span></div>
  const unavailable = expectedRevision === null
  const disabled = submitting || unavailable || !answer.trim() || feedback === 'accepted' || feedback === 'duplicate'
  return (
    <div data-agent-question-row="true" style={rowStyle}>
      <p style={questionStyle}>{question.question}</p>
      {question.options.length > 0 ? <div style={optionsStyle}>{question.options.map(option => <button key={option.value} type="button" aria-pressed={answer === option.value} onClick={() => onOption(option)} disabled={submitting || unavailable || feedback === 'accepted' || feedback === 'duplicate'} style={{ ...optionStyle, fontWeight: answer === option.value ? 700 : 400 }}>{option.label}</button>)}</div> : <input type="text" aria-label={question.question} placeholder={t('agent.question.freeTextPlaceholder')} maxLength={20_000} value={answer} onChange={event => onText(event.target.value)} disabled={submitting || unavailable || feedback === 'accepted' || feedback === 'duplicate'} style={inputStyle} />}
      <button type="button" disabled={disabled} onClick={() => expectedRevision !== null && onAnswer(question, answer, expectedRevision)} style={{ ...answerButtonStyle, opacity: disabled ? 0.68 : 1 }}>{submitting ? t('agent.question.submitting') : t('agent.question.answer')}</button>
      {unavailable && <p role="status" aria-live="polite" style={hintStyle}>{t('agent.question.turnUnavailable')}</p>}
      {feedback === 'accepted' && <p role="status" aria-live="polite" style={hintStyle}>{t('agent.question.accepted')}</p>}
      {feedback === 'duplicate' && <p role="status" aria-live="polite" style={hintStyle}>{t('agent.question.duplicate')}</p>}
      {feedback === 'failed' && <p role="alert" style={errorStyle}>{t('agent.question.actionFailed')}</p>}
    </div>
  )
}

function uniqueQuestions(items: readonly TimelineItem[], sessionId: string): QuestionInputProjection[] {
  const byQuestionId = new Map<string, QuestionInputProjection>()
  for (const item of items) {
    const question = parseQuestionInputItem(item, sessionId)
    const previous = question ? byQuestionId.get(question.questionId) : undefined
    if (question && (!previous || question.revision >= previous.revision)) byQuestionId.set(question.questionId, question)
  }
  return [...byQuestionId.values()].slice(0, 8)
}

function turnRevision(turns: readonly SupervisorTurnSummary[], sessionId: string, turnId: string): number | null {
  const turn = turns.find(candidate => candidate.sessionId === sessionId && candidate.id === turnId)
  return turn && Number.isSafeInteger(turn.revision) ? turn.revision : null
}

const cardStyle: React.CSSProperties = { display: 'grid', gap: 7, marginBottom: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg)' }
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12 }
const rowsStyle: React.CSSProperties = { display: 'grid', gap: 8, paddingTop: 5, borderTop: '1px solid var(--border)' }
const rowStyle: React.CSSProperties = { display: 'grid', gap: 6, color: 'var(--text)', fontSize: 11 }
const questionStyle: React.CSSProperties = { margin: 0, lineHeight: 1.4 }
const optionsStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 5 }
const optionStyle: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 7, padding: '5px 7px', color: 'var(--text)', background: 'var(--bg-secondary)', cursor: 'pointer', font: 'inherit', fontSize: 10 }
const inputStyle: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 7, padding: '6px 8px', color: 'var(--text)', background: 'var(--bg-secondary)', font: 'inherit', fontSize: 11 }
const answerButtonStyle: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 7, padding: '6px 8px', color: 'var(--text)', background: 'var(--bg-secondary)', cursor: 'pointer', font: 'inherit', fontSize: 10, fontWeight: 600 }
const mutedStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 9 }
const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.4 }
const errorStyle: React.CSSProperties = { ...hintStyle, color: 'var(--c-danger)' }
