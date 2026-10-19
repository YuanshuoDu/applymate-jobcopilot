'use client'

import React, { useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'

import { HarnessTimeline } from './HarnessTimeline'
import type { SupervisorTaskSummary } from './task-tree-projection'
import type { TimelineItem } from './timeline-reducer'

export interface ChildWorkerTask extends SupervisorTaskSummary {
  readonly attemptCount?: number | null
}
interface FollowUpTarget { readonly taskId: string; readonly turnId: string; readonly attemptCount: number }
interface FollowUpRequest extends FollowUpTarget { readonly sessionId: string; readonly clientMessageId: string; readonly text: string }

export function childFollowUpTarget(task: ChildWorkerTask | null, sessionId: string): FollowUpTarget | null {
  if (!task || task.sessionId !== sessionId || !task.rootTaskId || !task.parentTaskId || task.id === task.rootTaskId
    || task.status !== 'running' || !task.turnId || !Number.isSafeInteger(task.attemptCount) || Number(task.attemptCount) < 1) return null
  return { taskId: task.id, turnId: task.turnId, attemptCount: Number(task.attemptCount) }
}

export function taskTimelineItems(items: readonly TimelineItem[], taskId: string): TimelineItem[] {
  return items.filter(item => item.taskId === taskId)
}

export async function postChildTaskFollowUp(request: FollowUpRequest, refreshTasks: () => void | Promise<void>, fetcher: typeof fetch = fetch): Promise<'accepted' | 'conflict'> {
  const response = await fetcher(`/api/agent/sessions/${encodeURIComponent(request.sessionId)}/tasks/${encodeURIComponent(request.taskId)}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': request.clientMessageId },
    body: JSON.stringify({ clientMessageId: request.clientMessageId, expectedAttemptCount: request.attemptCount, text: request.text }),
  })
  if (response.status === 409) {
    try { await refreshTasks() } catch { /* Keep the rejected attempt locked if refresh fails. */ }
    return 'conflict'
  }
  if (!response.ok) throw new Error('Could not send worker follow-up')
  const body = await response.json().catch(() => null) as unknown
  const result = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {}
  if (result.taskId !== request.taskId || result.turnId !== request.turnId || result.targetAttemptCount !== request.attemptCount
    || typeof result.messageId !== 'string' || !result.messageId) throw new Error('Worker follow-up acceptance did not match its target')
  return 'accepted'
}

export function ChildWorkerAttachView({ sessionId, task, items, onClose, onConflict }: {
  readonly sessionId: string; readonly task: ChildWorkerTask; readonly items: readonly TimelineItem[]
  readonly onClose: () => void; readonly onConflict: () => void | Promise<void>
}) {
  const { lang } = useI18n()
  const target = childFollowUpTarget(task, sessionId)
  const taskItems = taskTimelineItems(items, task.id)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<'accepted' | 'conflict' | 'failed' | null>(null)
  const [feedbackAttempt, setFeedbackAttempt] = useState<number | null>(null)
  const requestKey = useRef<{ text: string; attemptCount: number; id: string } | null>(null)
  const locked = feedback === 'conflict' && feedbackAttempt === target?.attemptCount
  const copy = localizedCopy(lang === 'zh')
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!target || locked || busy || !text.trim()) return
    const message = text.trim()
    const previous = requestKey.current
    const clientMessageId = previous?.text === message && previous.attemptCount === target.attemptCount ? previous.id : crypto.randomUUID()
    requestKey.current = { text: message, attemptCount: target.attemptCount, id: clientMessageId }
    setBusy(true); setFeedback(null); setFeedbackAttempt(target.attemptCount)
    try {
      const result = await postChildTaskFollowUp({ ...target, sessionId, clientMessageId, text: message }, onConflict)
      if (result === 'conflict') setFeedback('conflict')
      else { requestKey.current = null; setText(''); setFeedback('accepted') }
    } catch { setFeedback('failed') } finally { setBusy(false) }
  }
  return <section aria-label={copy.activity} data-child-worker-attach="true" data-child-worker-task-id={task.id} style={workerViewStyle}>
    <div style={workerHeadingStyle}><strong>{task.role} · {target ? copy.attempt(target.attemptCount) : copy.attemptUnavailable}</strong><button type="button" onClick={onClose}>{copy.close}</button></div>
    {taskItems.length ? <HarnessTimeline items={taskItems} /> : <p role="status">{copy.noActivity}</p>}
    <form onSubmit={event => void submit(event)} style={{ display: 'grid', gap: 6 }}>
      <label>{copy.label}<textarea aria-label={copy.label} placeholder={copy.placeholder} maxLength={20_000} value={text} onChange={event => setText(event.target.value)} disabled={!target || locked || busy} /></label>
      <button type="submit" disabled={!target || locked || busy || !text.trim()}>{busy ? copy.sending : copy.send}</button>
    </form>
    {feedback === 'accepted' && feedbackAttempt === target?.attemptCount && <p role="status">{copy.accepted(feedbackAttempt)}</p>}
    {feedback === 'conflict' && <p role="status">{locked ? copy.conflictLocked : target ? copy.refreshed(target.attemptCount) : copy.noLongerEligible}</p>}
    {feedback === 'failed' && feedbackAttempt === target?.attemptCount && <p role="alert">{copy.failed}</p>}
  </section>
}

function localizedCopy(chinese: boolean) {
  return chinese ? {
    activity: '所选工作线程活动', attempt: (count: number) => `尝试 ${count}`, attemptUnavailable: '尝试次数不可用', close: '关闭视图',
    noActivity: '此工作线程尚无活动记录。', label: '跟进消息', placeholder: '向当前显示的尝试发送跟进消息', sending: '正在发送…', send: '发送跟进消息',
    accepted: (count: number) => `已接受发送给第 ${count} 次尝试的跟进消息。`, conflictLocked: '此尝试已被拒绝，无法继续发送跟进消息。',
    refreshed: (count: number) => `任务已刷新。当前尝试为 ${count}。`, noLongerEligible: '任务已刷新。此工作线程已不符合发送条件。',
    failed: '无法确认跟进消息是否已发送。可以安全地重试此消息。',
  } : {
    activity: 'Selected worker activity', attempt: (count: number) => `Attempt ${count}`, attemptUnavailable: 'Attempt unavailable', close: 'Close view',
    noActivity: 'No activity recorded for this worker yet.', label: 'Follow-up message', placeholder: 'Send a follow-up to the displayed attempt', sending: 'Sending…', send: 'Send follow-up',
    accepted: (count: number) => `Follow-up accepted for attempt ${count}.`, conflictLocked: 'This attempt was rejected and is locked for follow-ups.',
    refreshed: (count: number) => `Task refreshed. Attempt ${count} is current.`, noLongerEligible: 'Task refreshed. This worker is no longer eligible.',
    failed: 'Could not confirm the follow-up. Retrying this message is safe.',
  }
}

const workerViewStyle: React.CSSProperties = { display: 'grid', gap: 7, maxHeight: 350, overflowY: 'auto', padding: 8, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }
const workerHeadingStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, fontSize: 10 }
