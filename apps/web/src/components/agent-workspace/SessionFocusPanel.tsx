'use client'

import React from 'react'
import { useApi } from '@/lib/hooks'
import type { AgentSessionDetail } from './session-view-model'
import { sessionStatusLabel } from './session-view-model'
import { formQuestionFields } from '@/lib/agent/application-task-input'
import { useI18n } from '@/lib/i18n'
import { budgetViewState } from './agent-workspace-projection'
import { SessionStatusCards } from './SessionStatusCards'
import { SubmissionRecoveryControl } from './SubmissionRecoveryControl'
import { focusQuestionOptions } from './session-focus-parts'

interface DetailResponse { session: AgentSessionDetail }
function formWaitId(question: unknown): string | null { const waitId = question && typeof question === 'object' && !Array.isArray(question) ? (question as Record<string, unknown>).waitId : null; return typeof waitId === 'string' && waitId.trim() ? waitId : null }
export function formAnswerDraftKey(taskId: string, waitId: string, field: string) { return `${taskId}:${waitId}:${field}` }
export function RetryApplicationFillButton({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  async function onRetry(event: React.MouseEvent<HTMLButtonElement>) {
    const alert = event.currentTarget.nextElementSibling as HTMLDivElement | null
    if (alert) alert.textContent = ''
    try { await retryCancelledApplicationFill(sessionId, taskId) } catch (error) {
      if (alert) { const status = error instanceof Error ? /^server_rejected:(\d+)$/.exec(error.message)?.[1] : null; alert.textContent = status ? `Retry rejected by the server (HTTP ${status}). Refresh and try again.` : 'Could not retry the form fill. Check your connection and try again.' }
    }
  }
  return <><button type="button" onClick={onRetry} style={resumeButtonStyle}>Retry form fill</button><div role="alert" aria-live="assertive" /></>
}
async function retryCancelledApplicationFill(sessionId: string, taskId: string) {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'retry_application_fill', applicationTaskId: taskId, requestId: crypto.randomUUID() }) })
  if (!response.ok) throw new Error(`server_rejected:${response.status}`); window.dispatchEvent(new Event('applymate:sessions-changed'))
}
export function startApplicationFillRetryPolling(enabled: boolean, refresh: () => void) { if (!enabled) return () => {}; const timer = setInterval(refresh, 10_000); return () => clearInterval(timer) }
function isRetryableApplicationFill(task: { status: string; checkpoint: string | null }) { return (task.status === 'cancelled' && ['cancelled_by_user', 'turn_stopped_before_submit'].includes(task.checkpoint ?? '')) || (task.status === 'failed' && ['fill_prestart_failed', 'taskgraph_fill_failed'].includes(task.checkpoint ?? '')) }
export function needsApplicationFillRetryPolling(tasks: Array<{ id: string; status: string; checkpoint: string | null }>, readiness: Array<{ id: string; cancelledFillRetryReady: boolean }> | undefined, loading: boolean) {
  return !loading && tasks.some(task => isRetryableApplicationFill(task) && !readiness?.some(row => row.id === task.id && row.cancelledFillRetryReady))
}
type AttentionCallback = (sessionId: string, needsAttention: boolean) => void
export function SessionFocusPanel({ sessionId, onAttentionChange }: { sessionId: string | null; onAttentionChange?: AttentionCallback }) {
  if (!sessionId) return null
  return <SessionFocusPanelInner sessionId={sessionId} onAttentionChange={onAttentionChange} key={sessionId} />
}
function SessionFocusPanelInner({ sessionId, onAttentionChange }: { sessionId: string; onAttentionChange?: AttentionCallback }) {
  const { t } = useI18n()
  const { data, loading, error, refetch } = useApi<DetailResponse>(`/api/agent/sessions/${sessionId}`)
  const session = data?.session
  const approvals = session?.approvals ?? []
  const applicationTasks = session?.applicationTasks ?? []
  const hasApplicationFillRetryCandidate = applicationTasks.some(isRetryableApplicationFill)
  const { data: retryReadiness, loading: retryReadinessLoading, refetch: refetchRetryReadiness } = useApi<{ tasks: Array<{ id: string; cancelledFillRetryReady: boolean }> }>(`/api/agent/application-tasks?projection=cancelled-fill-retry&sessionId=${encodeURIComponent(sessionId)}`, { cache: false, enabled: hasApplicationFillRetryCandidate })
  const hasCancelledByUserRetryCandidate = applicationTasks.some(task => task.status === 'cancelled' && task.checkpoint === 'cancelled_by_user')
  const needsApplicationFillRetryReadiness = needsApplicationFillRetryPolling(applicationTasks, retryReadiness?.tasks, retryReadinessLoading)
  const execution = session?.execution
  const questions = session?.questions ?? []
  const pendingApprovals = approvals.filter(approval => approval.status === 'pending')
  const budget = session?.budget
  const budgetState = budgetViewState(budget?.used, budget?.limit)
  const actionableBudget = budget && (budget.warning?.trim() || budgetState === 'near_limit' || budgetState === 'exhausted') ? budget : undefined
  const needsAttention = pendingApprovals.length > 0
    || questions.some(question => !(question.answered === true || (question.answerAvailable === true && question.pending === false)))
    || applicationTasks.some(task => ['waiting_for_user', 'unknown', 'failed'].includes(task.status) || isRetryableApplicationFill(task))
    || Boolean(session?.uncertain?.length)
    || Boolean(actionableBudget)
  const attentionReady = Boolean(session) && !loading
  React.useEffect(() => {
    if (attentionReady) onAttentionChange?.(sessionId, needsAttention)
  }, [attentionReady, needsAttention, onAttentionChange, sessionId])
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  React.useEffect(() => {
    const refresh = () => { void refetch(); if (hasCancelledByUserRetryCandidate) void refetchRetryReadiness() }
    window.addEventListener('applymate:sessions-changed', refresh)
    const stopPolling = startApplicationFillRetryPolling(needsApplicationFillRetryReadiness, () => { void refetchRetryReadiness() })
    return () => { window.removeEventListener('applymate:sessions-changed', refresh); stopPolling() }
  }, [refetch, refetchRetryReadiness, hasCancelledByUserRetryCandidate, needsApplicationFillRetryReadiness])
  async function cancelApplicationTask(id: string) {
    const response = await fetch(`/api/agent/application-tasks?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (response.ok) {
      await refetch()
      window.dispatchEvent(new Event('applymate:sessions-changed'))
    }
  }
  async function cancelExecution(id: string) {
    const response = await fetch(`/api/agent/executions?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (response.ok) {
      await refetch()
      window.dispatchEvent(new Event('applymate:sessions-changed'))
    }
  }
  async function answerAndResume(id: string, waitId: string, fields: Array<{ key: string | null; label: string }>) {
    const submittedAnswers = Object.fromEntries(fields.flatMap(({ key }) => key ? [[key, answers[formAnswerDraftKey(id, waitId, key)] ?? '']] : []).filter(([, value]) => value.trim()))
    const response = await fetch('/api/agent/application-tasks', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, waitId, action: 'answer_and_resume', answers: submittedAnswers }) })
    if (response.ok) {
      await refetch()
      window.dispatchEvent(new Event('applymate:sessions-changed'))
    }
  }
  async function answerQuestion(questionId: string, answer: string) {
    const response = await fetch('/api/agent/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId, answer }),
    })
    if (response.ok) {
      await refetch()
      window.dispatchEvent(new Event('applymate:sessions-changed'))
    }
  }
  return (
    <>
      {(loading || error) && <Section title={t('agent.sessionDetails')}>
        {loading && <EmptyText>{t('agent.loadingTasks')}</EmptyText>}
        {error && <EmptyText>
          {t('agent.sessionDetailsUnavailable')} <button type="button" onClick={() => { void refetch() }} style={retryButtonStyle}>{t('agent.retry')}</button>
        </EmptyText>}
      </Section>}
      {pendingApprovals.length > 0 && <Section title={t('agent.approvals')}>
        {pendingApprovals.slice(0, 3).map(approval => (
          <div key={approval.id} style={rowStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={rowTitleStyle}>{approval.title}</div>
              <div style={rowMetaStyle}>{approval.type} · {sessionStatusLabel(approval.status)}</div>
            </div>
            <span style={{ ...badgeStyle, color: '#d97706' }}>{t('agent.waiting')}</span>
          </div>
        ))}
      </Section>}
      {applicationTasks.length > 0 && <Section title={t('agent.applicationTasks')}>
        {applicationTasks.map(task => {
          const fields = task.status === 'waiting_for_user' && task.checkpoint === 'form_answer_required' ? formQuestionFields(task.question) : []
          const waitId = formWaitId(task.question)
          const retryableFill = isRetryableApplicationFill(task)
          return (
          <div key={task.id} style={rowStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={rowTitleStyle}>{task.job.company} · {task.job.role}</div>
              <div style={rowMetaStyle}>{task.status}{task.checkpoint ? ` · ${task.checkpoint}` : ''}</div>
              {task.error && <div style={{ ...rowMetaStyle, color: '#d97706' }}>{task.error}</div>}
              {task.status === 'waiting_for_user' && task.checkpoint === 'submission_uncertain' && <SubmissionRecoveryControl sessionId={sessionId} applicationTaskId={task.id} taskStatus={task.status} checkpoint={task.checkpoint} />}
              {fields.length > 0 && !waitId && <div style={{ ...rowMetaStyle, color: '#d97706' }}>This saved form wait is missing its wait ID and cannot be safely resumed.</div>}
              {fields.map(field => field.key
                ? <input key={formAnswerDraftKey(task.id, waitId ?? '', field.key)} name={field.key} value={answers[formAnswerDraftKey(task.id, waitId ?? '', field.key)] ?? ''} onChange={event => setAnswers(current => ({ ...current, [formAnswerDraftKey(task.id, waitId ?? '', field.key!)]: event.target.value }))} placeholder={field.label} style={answerInputStyle} />
                : <div key={`unmapped:${task.id}:${waitId ?? ''}:${field.label}`} style={rowMetaStyle}>{field.label}</div>)}
              {fields.some(field => field.key !== null) && waitId && <button onClick={() => { void answerAndResume(task.id, waitId, fields) }} style={resumeButtonStyle}>{t('agent.confirmAnswersResume')}</button>}
            </div>
            {retryableFill && !retryReadinessLoading && retryReadiness?.tasks.some(row => row.id === task.id && row.cancelledFillRetryReady) && <RetryApplicationFillButton sessionId={sessionId} taskId={task.id} />}
            {!['submitted', 'skipped', 'cancelled'].includes(task.status) && (
              <button onClick={() => { void cancelApplicationTask(task.id) }} style={{ fontSize: 9, color: '#b91c1c', border: '1px solid var(--border)', background: 'transparent', borderRadius: 5, padding: '3px 5px', cursor: 'pointer' }}>{t('agent.cancel')}</button>
            )}
          </div>
          )
        })}
      </Section>}
      {execution && <Section title={t('agent.executionControl')}>
        <div style={rowStyle}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={rowTitleStyle}>{execution.status} · {execution.checkpoint}</div>
            <div style={rowMetaStyle}>attempt {execution.attemptCount}</div>
            {execution.error && <div style={{ ...rowMetaStyle, color: '#b91c1c' }}>{execution.error}</div>}
          </div>
          {!['completed', 'failed', 'cancelled'].includes(execution.status) && <button onClick={() => { void cancelExecution(execution.id) }} style={{ fontSize: 9, color: '#b91c1c', border: '1px solid var(--border)', background: 'transparent', borderRadius: 5, padding: '3px 5px', cursor: 'pointer' }}>{t('agent.cancelRun')}</button>}
        </div>
      </Section>}
      {questions.length > 0 && <Section title={t('agent.questionsWaiting')}>
        {questions.map(question => {
          const options = focusQuestionOptions(question.options)
          const answered = question.answered === true || (question.answerAvailable === true && question.pending === false)
          const pending = !answered && question.pending !== false
          return <div key={question.id} style={rowStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={rowTitleStyle}>{question.stage}</div>
              <div style={{ ...rowMetaStyle, whiteSpace: 'normal' }}>{question.question}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
                {answered ? <span style={{ ...rowMetaStyle, color: 'var(--c-success)' }}>Answered · read-only</span> : pending ? options.map(option => <button key={option.value} onClick={() => { void answerQuestion(question.id, option.value) }} style={resumeButtonStyle}>{option.label}</button>) : <span style={{ ...rowMetaStyle, color: '#d97706' }}>Answer state uncertain · refresh before acting.</span>}
              </div>
            </div>
          </div>
        })}
      </Section>}
      <SessionStatusCards artifacts={session?.artifacts} budget={actionableBudget} />
      {!!session?.uncertain?.length && <Section title={t('agent.needsAttention')}>
        {session.uncertain.map(item => <div key={item.id} style={rowStyle}>
          <div style={{ minWidth: 0, fontSize: 11, color: 'var(--text)', overflowWrap: 'anywhere' }}><strong>{item.label}</strong><div style={{ marginTop: 4 }}>{item.detail}</div></div>
        </div>)}
      </Section>}
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '0 10px 12px' }}>
      <div style={sectionTitleStyle}>{title}</div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}
function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 11px', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45 }}>
      {children}
    </div>
  )
}
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0,
  fontWeight: 700, marginBottom: 6,
}
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 10px',
  borderTop: '1px solid var(--border)',
}
const rowTitleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 650, color: 'var(--text)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const rowMetaStyle: React.CSSProperties = {
  fontSize: 9,
  color: 'var(--text-muted)',
  marginTop: 3,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const badgeStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 650,
  flexShrink: 0,
}
const answerInputStyle: React.CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '5px 6px', fontSize: 10, border: '1px solid var(--border)', borderRadius: 5, background: 'var(--bg)' }
const resumeButtonStyle: React.CSSProperties = { marginTop: 6, fontSize: 9, color: '#0f766e', border: '1px solid var(--border)', background: 'transparent', borderRadius: 5, padding: '3px 5px', cursor: 'pointer' }
const retryButtonStyle: React.CSSProperties = { marginLeft: 4, padding: 0, border: 0, color: 'var(--primary)', background: 'transparent', cursor: 'pointer', font: 'inherit', fontWeight: 700, textDecoration: 'underline' }
