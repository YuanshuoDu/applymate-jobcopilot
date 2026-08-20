'use client'

import React from 'react'
import { useApi } from '@/lib/hooks'
import type { AgentSessionDetail } from './session-view-model'
import { confidenceLabel, sessionStatusLabel, taskStatusColor, taskStatusLabel } from './session-view-model'
import { formQuestionFields } from '@/lib/agent/application-task-input'
import { useI18n } from '@/lib/i18n'

interface DetailResponse {
  session: AgentSessionDetail
}

export function SessionFocusPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n()
  if (!sessionId) {
    return (
      <Section title={t('agent.queuedTasks')}>
        <EmptyText>{t('agent.selectSessionDetails')}</EmptyText>
      </Section>
    )
  }

  return <SessionFocusPanelInner sessionId={sessionId} />
}

function SessionFocusPanelInner({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const { data, loading, error, refetch } = useApi<DetailResponse>(`/api/agent/sessions/${sessionId}`)
  const session = data?.session
  const tasks = session?.tasks ?? []
  const approvals = session?.approvals ?? []
  const applicationTasks = session?.applicationTasks ?? []
  const execution = session?.execution
  const questions = session?.questions ?? []
  const queuedTasks = tasks.filter(task => ['queued', 'running', 'retrying', 'waiting_for_user'].includes(task.status))
  const visibleTasks = queuedTasks.length > 0 ? queuedTasks : tasks.slice(-4)
  const pendingApprovals = approvals.filter(approval => approval.status === 'pending')
  const [answers, setAnswers] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    const refresh = () => { void refetch() }
    window.addEventListener('applymate:sessions-changed', refresh)
    return () => window.removeEventListener('applymate:sessions-changed', refresh)
  }, [refetch])

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

  async function answerAndResume(id: string, fields: string[]) {
    const submittedAnswers = Object.fromEntries(fields.map(field => [field, answers[`${id}:${field}`] ?? '']).filter(([, value]) => value.trim()))
    const response = await fetch('/api/agent/application-tasks', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'answer_and_resume', answers: submittedAnswers }),
    })
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
      <Section title={t('agent.queuedTasks')}>
        {loading && <EmptyText>{t('agent.loadingTasks')}</EmptyText>}
        {error && <EmptyText>
          {t('agent.sessionDetailsUnavailable')} <button type="button" onClick={() => { void refetch() }} style={retryButtonStyle}>{t('agent.retry')}</button>
        </EmptyText>}
        {!loading && !error && visibleTasks.length === 0 && <EmptyText>{t('agent.noTaskRecords')}</EmptyText>}
        {visibleTasks.map(task => <TaskRow key={task.id} task={task} />)}
      </Section>

      <Section title={t('agent.approvals')}>
        {!loading && pendingApprovals.length === 0 && <EmptyText>{t('agent.noPendingApprovals')}</EmptyText>}
        {pendingApprovals.slice(0, 3).map(approval => (
          <div key={approval.id} style={rowStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={rowTitleStyle}>{approval.title}</div>
              <div style={rowMetaStyle}>{approval.type} · {sessionStatusLabel(approval.status)}</div>
            </div>
            <span style={{ ...badgeStyle, color: '#d97706' }}>{t('agent.waiting')}</span>
          </div>
        ))}
      </Section>

      <Section title={t('agent.applicationTasks')}>
        {!loading && applicationTasks.length === 0 && <EmptyText>{t('agent.noApplicationTasks')}</EmptyText>}
        {applicationTasks.slice(0, 5).map(task => {
          const fields = task.status === 'waiting_for_user' && task.checkpoint === 'form_answer_required' ? formQuestionFields(task.question) : []
          return (
          <div key={task.id} style={rowStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={rowTitleStyle}>{task.job.company} · {task.job.role}</div>
              <div style={rowMetaStyle}>{task.status}{task.checkpoint ? ` · ${task.checkpoint}` : ''}</div>
              {task.error && <div style={{ ...rowMetaStyle, color: '#d97706' }}>{task.error}</div>}
              {fields.map(field => (
                <input key={field} value={answers[`${task.id}:${field}`] ?? ''} onChange={event => setAnswers(current => ({ ...current, [`${task.id}:${field}`]: event.target.value }))} placeholder={field} style={answerInputStyle} />
              ))}
              {fields.length > 0 && <button onClick={() => { void answerAndResume(task.id, fields) }} style={resumeButtonStyle}>{t('agent.confirmAnswersResume')}</button>}
            </div>
            {!['submitted', 'skipped', 'cancelled'].includes(task.status) && (
              <button onClick={() => { void cancelApplicationTask(task.id) }} style={{ fontSize: 9, color: '#b91c1c', border: '1px solid var(--border)', background: 'transparent', borderRadius: 5, padding: '3px 5px', cursor: 'pointer' }}>{t('agent.cancel')}</button>
            )}
          </div>
          )
        })}
      </Section>

      <Section title={t('agent.executionControl')}>
        {!loading && !execution && <EmptyText>{t('agent.noExecution')}</EmptyText>}
        {execution && <div style={rowStyle}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={rowTitleStyle}>{execution.status} · {execution.checkpoint}</div>
            <div style={rowMetaStyle}>attempt {execution.attemptCount}</div>
            {execution.error && <div style={{ ...rowMetaStyle, color: '#b91c1c' }}>{execution.error}</div>}
          </div>
          {!['completed', 'failed', 'cancelled'].includes(execution.status) && <button onClick={() => { void cancelExecution(execution.id) }} style={{ fontSize: 9, color: '#b91c1c', border: '1px solid var(--border)', background: 'transparent', borderRadius: 5, padding: '3px 5px', cursor: 'pointer' }}>{t('agent.cancelRun')}</button>}
        </div>}
      </Section>

      <Section title={t('agent.questionsWaiting')}>
        {!loading && questions.length === 0 && <EmptyText>{t('agent.noQuestions')}</EmptyText>}
        {questions.map(question => {
          const options = questionOptions(question.options)
          return <div key={question.id} style={rowStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={rowTitleStyle}>{question.stage}</div>
              <div style={{ ...rowMetaStyle, whiteSpace: 'normal' }}>{question.question}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
                {options.map(option => <button key={option.value} onClick={() => { void answerQuestion(question.id, option.value) }} style={resumeButtonStyle}>{option.label}</button>)}
              </div>
            </div>
          </div>
        })}
      </Section>

      <Section title={t('agent.sessionQuality')}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <QualityMetric label={t('agent.quality')} value={session?.qualityScore == null ? '--' : `${Math.round(session.qualityScore)}%`} />
          <QualityMetric label={t('agent.tasks')} value={tasks.length.toString()} />
          <QualityMetric label={t('agent.approvals')} value={approvals.length.toString()} warn={pendingApprovals.length > 0} />
          <QualityMetric label={t('common.status')} value={session ? sessionStatusLabel(session.status) : '--'} />
        </div>
      </Section>
    </>
  )
}

function TaskRow({ task }: { task: AgentSessionDetail['tasks'][number] }) {
  const color = taskStatusColor(task.status)
  return (
    <div style={rowStyle}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, marginTop: 5, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={rowTitleStyle}>{task.role} · {task.taskType}</div>
        <div style={rowMetaStyle}>
          {taskStatusLabel(task.status)} · {confidenceLabel(task.confidence)}
        </div>
        {task.failureReason && (
          <div style={{ ...rowMetaStyle, color: 'var(--c-danger)', marginTop: 3 }}>
            {task.failureReason}
          </div>
        )}
      </div>
    </div>
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

function QualityMetric({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ padding: '8px 9px', borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, lineHeight: 1.1, fontWeight: 750, color: warn ? '#d97706' : 'var(--text)' }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3 }}>{label}</div>
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
  fontSize: 10,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0,
  fontWeight: 700,
  marginBottom: 6,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '9px 10px',
  borderTop: '1px solid var(--border)',
}

const rowTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 650,
  color: 'var(--text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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

function questionOptions(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap(option => {
    if (!option || typeof option !== 'object') return []
    const record = option as { label?: unknown; value?: unknown }
    return typeof record.label === 'string' && typeof record.value === 'string' ? [{ label: record.label, value: record.value }] : []
  })
}
