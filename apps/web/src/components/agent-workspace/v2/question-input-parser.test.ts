import { describe, expect, it } from 'vitest'

import { parseQuestionInputItem, parseQuestionTerminalEvent } from './question-input-parser'

const item = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 'agent-harness.v2', id: 'item-question-1', sessionId: 'session-1', turnId: 'turn-1', taskId: null,
  type: 'question', status: 'started', revision: 0, startedAt: null, completedAt: null,
  createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
  content: { waitKind: 'question', questionId: 'question-1', stage: 'profile', question: 'Which option?', options: [{ value: 'yes', label: 'Yes' }], answerAvailable: false, pending: true },
  ...overrides,
})

describe('question input parser', () => {
  it('projects a bounded pending question and keeps option values out of its visible fields', () => {
    const parsed = parseQuestionInputItem(item(), 'session-1')
    expect(parsed).toMatchObject({ questionId: 'question-1', stage: 'profile', question: 'Which option?', status: 'pending', options: [{ value: 'yes', label: 'Yes' }] })
    expect(parseQuestionInputItem(item({ content: { ...item().content, answerAvailable: undefined } }), 'session-1')?.status).toBe('pending')
  })

  it('accepts safe answered and interrupted question terminals without returning answer content', () => {
    const answered = parseQuestionInputItem(item({ status: 'completed', revision: 1, content: { ...item().content, answerAvailable: true, answer: 'private answer', pending: false } }), 'session-1')
    expect(answered?.status).toBe('answered')
    expect(JSON.stringify(answered)).not.toContain('private answer')
    const cancelled = parseQuestionInputItem(item({ status: 'interrupted', content: { ...item().content, pending: false, cancelled: true, cancellationReason: 'interrupt' } }), 'session-1')
    expect(cancelled?.status).toBe('cancelled')
  })

  it('fails closed for OAuth, missing pending marker, malformed options, and foreign items', () => {
    expect(parseQuestionInputItem(item({ content: { ...item().content, oauth: true } }), 'session-1')).toBeNull()
    expect(parseQuestionInputItem(item({ content: { ...item().content, pending: false } }), 'session-1')).toBeNull()
    expect(parseQuestionInputItem(item({ content: { ...item().content, options: [{ value: 'yes' }] } }), 'session-1')).toBeNull()
    expect(parseQuestionInputItem(item({ sessionId: 'session-2' }), 'session-1')).toBeNull()
    expect(parseQuestionInputItem(item({ content: { ...item().content, question: '' } }), 'session-1')).toBeNull()
    expect(parseQuestionInputItem(item({ revision: '0' }), 'session-1')).toBeNull()
  })

  it('strictly maps answered and interrupt cancellation facts with live metadata', () => {
    const answered = { schemaVersion: 'agent-harness.v2', id: 'answered-1', sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-question-1', taskId: null, type: 'question.answered', actor: 'user', sequence: '9', correlationId: 'question-1', causationId: 'item-question-1', idempotencyKey: 'answer-1', createdAt: '2026-09-15T00:00:00.000Z', payload: { waitKind: 'question', waitId: 'question-1', itemId: 'item-question-1', turnId: 'turn-1', toolCallId: null, status: 'answered', nextTurnRevision: 3, answerAvailable: true } }
    expect(parseQuestionTerminalEvent(answered, 'session-1')).toMatchObject({ questionId: 'question-1', status: 'completed' })
    const cancelled = { ...answered, id: 'cancelled-1', type: 'question.cancelled', actor: 'system', sequence: '10', payload: { waitKind: 'question', waitId: 'question-1', itemId: 'item-question-1', toolCallId: null, outcome: 'cancelled', reason: 'interrupt' } }
    expect(parseQuestionTerminalEvent(cancelled, 'session-1')).toMatchObject({ questionId: 'question-1', status: 'interrupted' })
    expect(parseQuestionTerminalEvent({ ...answered, payload: { ...answered.payload, answer: 'private answer' } }, 'session-1')).toBeNull()
  })
})
