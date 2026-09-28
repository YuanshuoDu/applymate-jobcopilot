'use client'

import React, { useMemo } from 'react'
import { parsePlanLedger } from '@jobcopilot/agent-protocol'

import { useI18n, type Lang } from '@/lib/i18n'
import { taskGraphPlanLabel, type TaskGraphPlanLabelKey } from '@/lib/task-graph-plan-labels'

import { projectCurrentTaskGraph, type TaskGraphEvidencePreview, type TaskGraphPlan, type TaskGraphPlanReadiness, type TaskGraphPlanStatus } from './task-graph-plan'
import { selectedTaskGraphIdentity, type TaskGraphIdentity } from './task-graph-plan-query'
import type { SupervisorTaskSummary } from './task-tree-projection'
import type { TimelineItem } from './timeline-reducer'

const READINESS_LABELS: Record<TaskGraphPlanReadiness, TaskGraphPlanLabelKey> = {
  ready: 'agent.taskGraph.readiness.ready',
  waiting_for_dependencies: 'agent.taskGraph.readiness.waitingForDependencies',
  blocked_dependency: 'agent.taskGraph.readiness.blockedDependency',
  active: 'agent.taskGraph.readiness.active',
  terminal: 'agent.taskGraph.readiness.terminal',
  unavailable: 'agent.taskGraph.readiness.unavailable',
}

const STATUS_LABELS: Record<TaskGraphPlanStatus, TaskGraphPlanLabelKey> = {
  queued: 'agent.taskGraph.status.queued',
  running: 'agent.taskGraph.status.running',
  retrying: 'agent.taskGraph.status.retrying',
  waiting: 'agent.taskGraph.status.waiting',
  waiting_for_user: 'agent.taskGraph.status.waitingForUser',
  completed: 'agent.taskGraph.status.completed',
  failed: 'agent.taskGraph.status.failed',
  interrupted: 'agent.taskGraph.status.interrupted',
  cancelled: 'agent.taskGraph.status.cancelled',
  closed: 'agent.taskGraph.status.closed',
}

export function TaskGraphPlanPanel({ sessionId, items, tasks, ledger }: {
  readonly sessionId: string
  readonly items: readonly TimelineItem[]
  readonly tasks: readonly SupervisorTaskSummary[]
  readonly ledger?: unknown
}) {
  const { lang, t } = useI18n()
  const plan = useMemo(() => {
    const identity = selectedTaskGraphIdentity(items, sessionId)
    const scopedTasks = identity ? tasks.filter(task => task.sessionId === identity.sessionId && task.turnId === identity.turnId
      && task.rootTaskId === identity.rootTaskId) : []
    const current = projectCurrentTaskGraph(items, scopedTasks, sessionId)
    const response = parsePlanLedgerResponse(ledger)
    return response && sameTaskGraphIdentity(response.identity, identity) ? response.projection : current
  }, [items, ledger, sessionId, tasks])
  if (!plan) return null

  return <TaskGraphPlanSection plan={plan} sessionId={sessionId} lang={lang} t={t} />
}

function parsePlanLedgerResponse(value: unknown): { identity: TaskGraphIdentity; projection: TaskGraphPlan } | null {
  const response = record(value)
  const identity = response ? record(response.identity) : null
  if (!response || !identity || Object.keys(response).length !== 2 || Object.keys(identity).length !== 5
    || typeof identity.sessionId !== 'string' || typeof identity.graphItemId !== 'string'
    || typeof identity.turnId !== 'string' || typeof identity.rootTaskId !== 'string'
    || ![identity.sessionId, identity.graphItemId, identity.turnId, identity.rootTaskId].every(value => value.length > 0 && value.length <= 128 && value.trim() === value)
    || !Number.isSafeInteger(identity.revision) || Number(identity.revision) < 1) return null
  const projection = parsePlanLedger(response.projection)
  if (!projection || projection.sessionId !== identity.sessionId || projection.revision !== identity.revision) return null
  return { identity: identity as unknown as TaskGraphIdentity, projection }
}

function sameTaskGraphIdentity(left: TaskGraphIdentity, right: TaskGraphIdentity | null): boolean {
  return Boolean(right && left.sessionId === right.sessionId && left.graphItemId === right.graphItemId
    && left.turnId === right.turnId && left.rootTaskId === right.rootTaskId && left.revision === right.revision)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function TaskGraphPlanSection({ plan, sessionId, lang, t }: {
  readonly plan: TaskGraphPlan
  readonly sessionId: string
  readonly lang: Lang
  readonly t: (key: string) => string
}) {
  return (
    <section
      aria-label={taskGraphPlanLabel(lang, 'agent.taskGraph.currentPlan')}
      data-agent-task-graph-plan="true"
      data-agent-task-graph-session={sessionId}
      data-agent-task-graph-revision={plan.revision}
      style={sectionStyle}
    >
      <h3 style={headingStyle}>{taskGraphPlanLabel(lang, 'agent.taskGraph.currentPlan')}</h3>
      <div><span>{t('agent.approvalLedger.revision')}:</span> {plan.revision}</div>
      {plan.goal && <p data-agent-task-graph-goal="true" style={planGoalStyle}>{plan.goal}</p>}
      <ol style={listStyle}>
        {plan.nodes.map(node => (
          <li key={node.key} style={nodeStyle}>
            <strong style={goalStyle}>{node.goal}</strong>
            <div>{t('agent.status')}: {node.status ? taskGraphPlanLabel(lang, STATUS_LABELS[node.status]) : taskGraphPlanLabel(lang, 'agent.taskGraph.statusUnavailable')}</div>
            {node.evidencePreview
              ? <TaskGraphEvidenceSummary preview={node.evidencePreview} lang={lang} />
              : node.resultAvailable && <div data-task-graph-evidence="available">{t('agent.toolResult')}</div>}
            <div>
              {taskGraphPlanLabel(lang, 'agent.taskGraph.dependencies')}:{' '}
              {node.dependencies.length === 0
                ? taskGraphPlanLabel(lang, 'agent.taskGraph.noDependencies')
                : <ul style={dependencyListStyle}>{node.dependencies.map(dependency => (
                  <li key={dependency.key}>
                    {dependency.label} — {dependency.status ? taskGraphPlanLabel(lang, STATUS_LABELS[dependency.status]) : taskGraphPlanLabel(lang, 'agent.taskGraph.statusUnavailable')}
                  </li>
                ))}</ul>}
            </div>
            <div><span>{taskGraphPlanLabel(lang, 'agent.taskGraph.readiness')}:</span> {taskGraphPlanLabel(lang, READINESS_LABELS[node.readiness])}</div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function TaskGraphEvidenceSummary({ preview, lang }: { readonly preview: TaskGraphEvidencePreview; readonly lang: Lang }) {
  return (
    <div data-task-graph-evidence="preview" style={evidenceStyle}>
      <strong>{taskGraphPlanLabel(lang, 'agent.taskGraph.evidenceSummary')}</strong>
      <span>{preview.summary}</span>
      <span>{preview.role} · {preview.itemCount}</span>
      {preview.evidence.length > 0 && <ul style={evidenceListStyle}>
        {preview.evidence.map((entry, index) => (
          <li key={`${entry.kind}:${entry.source}:${index}`}>
            <span>{entry.kind} · {entry.source}</span>
            {entry.reference && <code>{entry.reference}</code>}
          </li>
        ))}
      </ul>}
    </div>
  )
}

const sectionStyle: React.CSSProperties = { display: 'grid', gap: 7, margin: '10px 0', padding: '9px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.45 }
const headingStyle: React.CSSProperties = { margin: 0, color: 'var(--text)', fontSize: 12 }
const planGoalStyle: React.CSSProperties = { margin: 0, color: 'var(--text)', fontSize: 11, fontWeight: 650, overflowWrap: 'anywhere' }
const listStyle: React.CSSProperties = { display: 'grid', gap: 8, margin: 0, paddingLeft: 18 }
const nodeStyle: React.CSSProperties = { display: 'grid', gap: 3, minWidth: 0, overflowWrap: 'anywhere' }
const goalStyle: React.CSSProperties = { color: 'var(--text)', fontSize: 11 }
const dependencyListStyle: React.CSSProperties = { display: 'grid', gap: 2, margin: '3px 0 0', paddingLeft: 16 }
const evidenceStyle: React.CSSProperties = { display: 'grid', gap: 2, borderLeft: '2px solid var(--border)', paddingLeft: 6, overflowWrap: 'anywhere' }
const evidenceListStyle: React.CSSProperties = { display: 'grid', gap: 2, margin: 0, paddingLeft: 16 }
