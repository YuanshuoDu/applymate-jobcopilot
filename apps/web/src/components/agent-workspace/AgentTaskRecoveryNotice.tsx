'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'

import type { AgentComposerTaskRecoveryNoticeState } from './agent-composer-task-recovery'

export interface AgentTaskRecoveryNoticeProps {
  state: AgentComposerTaskRecoveryNoticeState
  onOpenAccepted: (sessionId: string, turnId: string) => void | Promise<void>
  onCheck: () => Promise<void>
  onAbandonAttempt: () => Promise<void>
  onRemoveRecoveryNotice: () => void | Promise<void>
}

const EN = {
  title: 'Task start recovery',
  loading: 'Checking whether the task was accepted…',
  accepted: 'The task start was accepted. Open the original task to view its current status.',
  open: 'Open accepted task',
  unknown: 'We can’t confirm whether this task started. Check again, or explicitly abandon this start attempt. Abandoning only marks the attempt; it does not stop a task that may already have started.',
  checking: 'Checking whether the task was accepted…',
  check: 'Check start status',
  abandon: 'Abandon this start attempt',
  abandoned: 'This start attempt is marked abandoned. A Session created before its outcome was confirmed may still remain without a task.',
  unavailable: 'Recovery status could not be confirmed. We can’t tell whether the task started, so starting another task could create a duplicate. Try again when recovery is available.',
  acceptedMissing: 'The task was accepted, but its original Session or Turn is no longer available. This does not undo the accepted task.',
  remove: 'Remove local recovery notice',
}

const ZH = {
  title: '任务启动恢复',
  loading: '正在确认任务是否已被接受…',
  accepted: '任务启动请求已被接受。打开原任务查看当前状态。',
  open: '打开已接受的任务',
  unknown: '目前无法确认任务是否已启动。你可以再次检查，或明确放弃本次启动尝试。放弃只会标记这次尝试；如果任务已经启动，也不会停止它。',
  checking: '正在确认任务是否已被接受…',
  check: '检查启动状态',
  abandon: '放弃本次启动尝试',
  abandoned: '本次启动尝试已标记为放弃。如果状态确认前已创建 Session，它仍可能存在，但没有任务。',
  unavailable: '无法确认恢复状态。我们无法判断任务是否已经启动，因此再次启动可能会创建重复任务。请在恢复功能可用后重试。',
  acceptedMissing: '任务已被接受，但原 Session 或 Turn 已不可用。这不会撤销已接受的任务。',
  remove: '移除此恢复提示',
}

function run(action: () => void | Promise<void>): void {
  try { void Promise.resolve(action()).catch(() => undefined) } catch { /* The controller reports action failures through its next state. */ }
}

export function AgentTaskRecoveryNotice({
  state, onOpenAccepted, onCheck, onAbandonAttempt, onRemoveRecoveryNotice,
}: AgentTaskRecoveryNoticeProps) {
  const { lang } = useI18n()
  const copy = lang === 'zh' ? ZH : EN
  const busy = state.kind === 'loading' || state.kind === 'unknown' && state.busy === true
  const body = state.kind === 'loading' ? copy.loading
    : state.kind === 'accepted' ? copy.accepted
      : state.kind === 'unknown' ? (state.busy ? copy.checking : copy.unknown)
        : state.kind === 'abandoned' ? copy.abandoned
          : state.reason === 'accepted-target-missing' ? copy.acceptedMissing : copy.unavailable

  return (
    <section
      role="region"
      aria-label={copy.title}
      data-task-recovery-notice={state.kind}
      style={{ margin: '0 10px 10px', padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}
    >
      <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--text)' }}>{copy.title}</div>
      <p role="status" aria-live="polite" style={{ margin: '6px 0 0', fontSize: 11, lineHeight: 1.45, color: 'var(--text-muted)' }}>{body}</p>
      {state.kind === 'accepted' && (
        <button type="button" aria-label={copy.open} onClick={() => run(() => onOpenAccepted(state.sessionId, state.turnId))} style={buttonStyle}>
          {copy.open}
        </button>
      )}
      {state.kind === 'unknown' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <button type="button" aria-label={copy.check} disabled={busy} onClick={() => run(onCheck)} style={buttonStyle}>{copy.check}</button>
          <button type="button" aria-label={copy.abandon} disabled={busy} onClick={() => run(onAbandonAttempt)} style={buttonStyle}>{copy.abandon}</button>
        </div>
      )}
      {state.kind === 'unavailable' && state.reason === 'accepted-target-missing' && (
        <button type="button" aria-label={copy.remove} onClick={() => run(onRemoveRecoveryNotice)} style={buttonStyle}>{copy.remove}</button>
      )}
      {state.kind === 'abandoned' && (
        <button type="button" aria-label={copy.remove} onClick={() => run(onRemoveRecoveryNotice)} style={buttonStyle}>{copy.remove}</button>
      )}
    </section>
  )
}

const buttonStyle: React.CSSProperties = {
  marginTop: 8, minHeight: 32, padding: '5px 9px', border: '1px solid var(--border)', borderRadius: 6,
  background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer', fontSize: 11,
}
