'use client'

import React from 'react'

import { useI18n } from '@/lib/i18n'

import type { ChildWorkerTask } from './ChildWorkerAttachView'
import { agentWaitCopy } from './agent-wait-copy'
import { useAgentTaskWait, type AgentTaskWaitState } from './use-agent-task-wait'
import type { AgentTaskWaitDto } from '@/app/api/agent/sessions/[id]/tasks/[taskId]/waits/wait-projection'

export interface AgentTaskWaitDetailsCardProps {
  readonly sessionId: string
  readonly parent: ChildWorkerTask
  readonly lifecycleRevision: number
  readonly selectedTaskId?: string
  readonly taskNodeIds: ReadonlySet<string>
  readonly onSelectTarget: (taskId: string) => void
}

const ACTIVE_PARENT_STATUSES = new Set(['queued', 'running', 'retrying', 'waiting', 'waiting_for_user'])

export function isEligibleWaitParent(task: ChildWorkerTask): boolean {
  return Boolean(task.rootTaskId && task.parentTaskId && task.id !== task.rootTaskId && ACTIVE_PARENT_STATUSES.has(task.status))
}

export function AgentTaskWaitDetailsCard(props: AgentTaskWaitDetailsCardProps) {
  const query = useAgentTaskWait({
    sessionId: props.sessionId,
    parentTaskId: props.parent.id,
    lifecycleRevision: props.lifecycleRevision,
    enabled: isEligibleWaitParent(props.parent),
  })
  return <AgentTaskWaitDetailsContent
    state={query} selectedTaskId={props.selectedTaskId} taskNodeIds={props.taskNodeIds}
    onSelectTarget={props.onSelectTarget}
  />
}

export function AgentTaskWaitDetailsContent({ state, selectedTaskId, taskNodeIds, onSelectTarget }: {
  readonly state: AgentTaskWaitState
  readonly selectedTaskId?: string
  readonly taskNodeIds: ReadonlySet<string>
  readonly onSelectTarget: (taskId: string) => void
}) {
  const { lang } = useI18n()
  const copy = agentWaitCopy(lang)
  return (
    <section aria-label={copy.heading} data-agent-task-wait-details="true" data-wait-state={state.phase} data-wait-loading={state.loading ? 'true' : 'false'} style={cardStyle}>
      <strong style={{ fontSize: 11 }}>{copy.heading}</strong>
      {state.phase === 'checking' && !state.wait && <p role="status" style={messageStyle}>{copy.loading}</p>}
      {state.loading && state.wait && <p role="status" style={messageStyle}>{copy.loading}</p>}
      {state.phase === 'empty' && <p role="status" style={messageStyle}>{copy.empty}</p>}
      {state.phase === 'unavailable' && <p role="status" style={messageStyle}>{copy.unavailable}</p>}
      {state.phase === 'error' && <p role="status" style={messageStyle}>{copy.error}</p>}
      {state.wait && <WaitProjectionView
        wait={state.wait} due={state.due} copy={copy} lang={lang} selectedTaskId={selectedTaskId}
        taskNodeIds={taskNodeIds} onSelectTarget={onSelectTarget}
      />}
    </section>
  )
}

function WaitProjectionView({ wait, due, copy, lang, selectedTaskId, taskNodeIds, onSelectTarget }: {
  readonly wait: AgentTaskWaitDto
  readonly due: AgentTaskWaitState['due']
  readonly copy: ReturnType<typeof agentWaitCopy>
  readonly lang: string
  readonly selectedTaskId?: string
  readonly taskNodeIds: ReadonlySet<string>
  readonly onSelectTarget: (taskId: string) => void
}) {
  const deadline = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(wait.deadlineAt))
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <dl style={summaryStyle}>
        <div><dt>{copy.mode}</dt><dd>{wait.mode === 'any' ? copy.anyMode : copy.allMode}</dd></div>
        <div><dt>{copy.status}</dt><dd>{copy.statuses[wait.status] ?? wait.status}</dd></div>
        <div><dt>{copy.deadline}</dt><dd><time dateTime={wait.deadlineAt}>{deadline}</time>{due === 'wait' && <span role="status"> · {copy.waitDue}</span>}</dd></div>
        <div><dt>{copy.taskDeadline}</dt><dd>{wait.parentDeadlineAt
          ? <><time dateTime={wait.parentDeadlineAt}>{new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(wait.parentDeadlineAt))}</time>{due === 'parent' && <span role="status"> · {copy.taskDue}</span>}</>
          : copy.taskDeadlineUnrecorded}</dd></div>
      </dl>
      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{copy.children}</span>
      <ul style={targetListStyle}>
        {wait.targets.map(target => {
          const label = target.label?.trim() || copy.child
          const selected = target.taskId === selectedTaskId
          return <li key={target.taskId} data-agent-wait-target={target.taskId} style={targetStyle}>
            <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
              <strong style={{ fontSize: 10, overflowWrap: 'anywhere' }}>{label}</strong>
              <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{copy.status}: {copy.statuses[target.status] ?? target.status}</span>
              <span data-wait-target-matched={target.matched ? 'true' : 'false'} style={{ fontSize: 10 }}>
                {target.matched ? copy.matched : copy.notMatched}
              </span>
            </div>
            {taskNodeIds.has(target.taskId) && <button
              type="button" aria-label={copy.selectTarget(label)} aria-pressed={selected}
              onClick={() => onSelectTarget(target.taskId)} style={selectStyle}
            >{selected ? copy.selected : copy.selectTarget(label)}</button>}
          </li>
        })}
      </ul>
    </div>
  )
}

const cardStyle: React.CSSProperties = { display: 'grid', gap: 6, padding: 8, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)' }
const messageStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.4 }
const summaryStyle: React.CSSProperties = { display: 'grid', gap: 4, margin: 0, fontSize: 10 }
const targetListStyle: React.CSSProperties = { display: 'grid', gap: 5, listStyle: 'none', margin: 0, padding: 0 }
const targetStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: 6, border: '1px solid var(--border)', borderRadius: 6 }
const selectStyle: React.CSSProperties = { flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 5, padding: '4px 6px', background: 'var(--bg)', color: 'var(--primary)', cursor: 'pointer', font: 'inherit', fontSize: 9 }
