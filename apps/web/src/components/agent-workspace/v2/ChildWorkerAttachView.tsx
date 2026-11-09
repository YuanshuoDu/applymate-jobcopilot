'use client'

import React, { useRef, useState } from 'react'

import { redactSensitiveText } from '@jobcopilot/shared/agent-redaction'
import { useI18n } from '@/lib/i18n'

import { HarnessTimeline } from './HarnessTimeline'
import type { SupervisorTaskSummary } from './task-tree-projection'
import type { TimelineItem } from './timeline-reducer'

export interface ChildWorkerTask extends SupervisorTaskSummary {
  readonly attemptCount?: number | null
}
interface FollowUpTarget { readonly taskId: string; readonly turnId: string; readonly attemptCount: number }
interface FollowUpRequest extends FollowUpTarget { readonly sessionId: string; readonly clientMessageId: string; readonly text: string }
const SAFE_CHILD_TIMELINE_TYPES = new Set(['agent_message', 'tool_call', 'tool_result', 'approval_request', 'question', 'task_graph'])

export function childFollowUpTarget(task: ChildWorkerTask | null, sessionId: string): FollowUpTarget | null {
  if (!task || task.sessionId !== sessionId || !task.rootTaskId || !task.parentTaskId || task.id === task.rootTaskId
    || task.status !== 'running' || !task.turnId || !Number.isSafeInteger(task.attemptCount) || Number(task.attemptCount) < 1) return null
  return { taskId: task.id, turnId: task.turnId, attemptCount: Number(task.attemptCount) }
}

export function taskTimelineItems(items: readonly TimelineItem[], taskId: string): TimelineItem[] {
  return items.filter(item => item.taskId === taskId && SAFE_CHILD_TIMELINE_TYPES.has(item.type)).map(projectChildTimelineItem)
}

function projectChildTimelineItem(item: TimelineItem): TimelineItem {
  return {
    schemaVersion: item.schemaVersion, id: item.id, sessionId: item.sessionId, turnId: item.turnId,
    stepId: item.stepId, taskId: item.taskId, type: item.type, status: item.status, phase: item.phase,
    revision: item.revision, content: item.type === 'tool_call' || item.type === 'tool_result' ? {} : { parts: [{ type: 'redacted' }] },
    startedAt: item.startedAt, completedAt: item.completedAt, createdAt: item.createdAt, updatedAt: item.updatedAt,
    source: item.source, sequence: item.sequence,
  }
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
  const createdAt = displayTimestamp(task.createdAt)
  const updatedAt = displayTimestamp(task.updatedAt)
  const failureSummary = safeFailureSummary(task.failureReason)
  const hasFailureReason = typeof task.failureReason === 'string' && task.failureReason.trim().length > 0
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
    <div style={workerHeadingStyle}><strong>{task.role} · {displayAttempt(task.attemptCount, copy)}</strong><button type="button" onClick={onClose}>{copy.close}</button></div>
    <div role="group" aria-label={copy.details} data-worker-details-task-id={task.id} style={workerDetailsStyle}>
      <div style={{ minWidth: 0 }}>
        <div style={detailLabelStyle}>{copy.goal}</div>
        <div data-worker-goal-task-id={task.id} style={goalValueStyle}>{boundedGoal(task.goal) || copy.goalUnavailable}</div>
      </div>
      <dl style={workerDetailsGridStyle}>
        <WorkerDetail label={copy.status} value={displayStatus(task.status, copy)} />
        <WorkerDetail label={copy.result} value={task.hasResult === true ? copy.available : copy.unavailable} />
        <WorkerDetail label={copy.artifact} value={task.artifactRef ? copy.available : copy.unavailable} />
        {createdAt && <WorkerDetail label={copy.created} value={<time dateTime={createdAt.iso}>{createdAt.label}</time>} />}
        {updatedAt && <WorkerDetail label={copy.updated} value={<time dateTime={updatedAt.iso}>{updatedAt.label}</time>} />}
        {hasFailureReason && <WorkerDetail label={copy.failureSummary} value={failureSummary ?? copy.failureHidden} />}
      </dl>
    </div>
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
    details: '工作线程详情', goal: '目标', goalUnavailable: '目标不可用', status: '状态', result: '结果', artifact: '工件',
    available: '可用', unavailable: '不可用', created: '创建时间', updated: '最近更新', failureSummary: '失败摘要', failureHidden: '出于隐私保护，详情已隐藏', unknownStatus: '未知',
    queuedStatus: '排队中', runningStatus: '运行中', retryingStatus: '重试中', waitingStatus: '等待中', completedStatus: '已完成', failedStatus: '失败', interruptedStatus: '已中断', skippedStatus: '已跳过',
    noActivity: '此工作线程尚无活动记录。', label: '跟进消息', placeholder: '向当前显示的尝试发送跟进消息', sending: '正在发送…', send: '发送跟进消息',
    accepted: (count: number) => `已接受发送给第 ${count} 次尝试的跟进消息。`, conflictLocked: '此尝试已被拒绝，无法继续发送跟进消息。',
    refreshed: (count: number) => `任务已刷新。当前尝试为 ${count}。`, noLongerEligible: '任务已刷新。此工作线程已不符合发送条件。',
    failed: '无法确认跟进消息是否已发送。可以安全地重试此消息。',
  } : {
    activity: 'Selected worker activity', attempt: (count: number) => `Attempt ${count}`, attemptUnavailable: 'Attempt unavailable', close: 'Close view',
    details: 'Worker details', goal: 'Goal', goalUnavailable: 'Goal unavailable', status: 'Status', result: 'Result', artifact: 'Artifact',
    available: 'Available', unavailable: 'Unavailable', created: 'Created', updated: 'Updated', failureSummary: 'Failure summary', failureHidden: 'Failure details hidden for privacy', unknownStatus: 'Unknown',
    queuedStatus: 'Queued', runningStatus: 'Running', retryingStatus: 'Retrying', waitingStatus: 'Waiting', completedStatus: 'Completed', failedStatus: 'Failed', interruptedStatus: 'Interrupted', skippedStatus: 'Skipped',
    noActivity: 'No activity recorded for this worker yet.', label: 'Follow-up message', placeholder: 'Send a follow-up to the displayed attempt', sending: 'Sending…', send: 'Send follow-up',
    accepted: (count: number) => `Follow-up accepted for attempt ${count}.`, conflictLocked: 'This attempt was rejected and is locked for follow-ups.',
    refreshed: (count: number) => `Task refreshed. Attempt ${count} is current.`, noLongerEligible: 'Task refreshed. This worker is no longer eligible.',
    failed: 'Could not confirm the follow-up. Retrying this message is safe.',
  }
}

type WorkerCopy = ReturnType<typeof localizedCopy>
const SAFE_FAILURE_SUMMARIES = new Set([
  'task_graph_verification_failed', 'task_graph_verification_unverified', 'task_graph_repair_target_unresolved',
  'task_graph_child_deadline_exceeded', 'task_graph_dependency_scope_mismatch', 'no_progress',
  'child_turn_missing', 'child_mailbox_continuation_unsupported', 'child_mailbox_continuation_unavailable',
  'child_mailbox_continuation_checkpoint_unavailable', 'child_resume_unavailable', 'child_resume_evidence_unavailable',
  'child_resume_wait_step_lineage', 'selected_job_context_unavailable', 'selected_job_sources_unavailable',
  'selected_job_output_contract_unavailable', 'writer_dependency_unavailable', 'writer_review_revision_role_invalid',
  'subagent_role_unknown', 'invalid_structured_result', 'native_verification_report_invalid',
  'subagent_mailbox_input_unavailable', 'subagent_mailbox_no_progress', 'subagent_mailbox_continuation_limit',
  'subagent_mailbox_continuation_failed',
  'scheduled_gate_result_invalid', 'scheduled_gate_role_task_type_mismatch', 'scheduled_audit_handoff_retryable',
  'application_fill_role_task_type_mismatch', 'application_fill_continuation_unsupported',
])

function displayAttempt(value: number | null | undefined, copy: WorkerCopy): string {
  return Number.isSafeInteger(value) && Number(value) > 0 ? copy.attempt(Number(value)) : copy.attemptUnavailable
}

function boundedGoal(value: string): string {
  const goal = redactSensitiveText(typeof value === 'string' ? value.trim() : '')
  if (goal.length <= 280) return goal
  return `${goal.slice(0, 279).trimEnd()}…`
}

function safeFailureSummary(value: string | null | undefined): string | null {
  const reason = typeof value === 'string' ? value.trim() : ''
  return SAFE_FAILURE_SUMMARIES.has(reason) ? reason : null
}

function displayStatus(status: string, copy: WorkerCopy): string {
  const labels: Record<string, string> = {
    queued: copy.queuedStatus, running: copy.runningStatus, in_progress: copy.runningStatus, retrying: copy.retryingStatus,
    waiting: copy.waitingStatus, waiting_for_user: copy.waitingStatus, waiting_for_dependency: copy.waitingStatus,
    waiting_for_approval: copy.waitingStatus, completed: copy.completedStatus, passed: copy.completedStatus,
    failed: copy.failedStatus, error: copy.failedStatus, interrupted: copy.interruptedStatus, cancelled: copy.interruptedStatus,
    skipped: copy.skippedStatus,
  }
  return Object.prototype.hasOwnProperty.call(labels, status) ? labels[status]! : copy.unknownStatus
}

function displayTimestamp(value: string | undefined): { iso: string; label: string } | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const iso = date.toISOString()
  return {
    iso,
    label: `${iso.slice(0, 16).replace('T', ' ')} UTC`,
  }
}

function WorkerDetail({ label, value }: { label: string; value: React.ReactNode }) {
  return <div style={{ minWidth: 0 }}><dt style={detailLabelStyle}>{label}</dt><dd style={detailValueStyle}>{value}</dd></div>
}

const workerViewStyle: React.CSSProperties = { display: 'grid', gap: 7, maxHeight: 350, overflowY: 'auto', padding: 8, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }
const workerHeadingStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, fontSize: 12 }
const workerDetailsStyle: React.CSSProperties = { display: 'grid', gap: 8, minWidth: 0, padding: 8, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)' }
const workerDetailsGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: '7px 10px', margin: 0 }
const detailLabelStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 11, fontWeight: 650, marginBottom: 3 }
const detailValueStyle: React.CSSProperties = { color: 'var(--text)', fontSize: 12, margin: 0, overflowWrap: 'anywhere' }
const goalValueStyle: React.CSSProperties = { color: 'var(--text)', fontSize: 12, lineHeight: 1.4, overflowWrap: 'anywhere' }
