'use client'

import React from 'react'
import { parseTaskGraphVerificationSummary, type TaskGraphVerificationDisplayNode } from '@jobcopilot/agent-protocol'

import type { Lang } from '@/lib/i18n'
import {
  parseFinalTaskGraphSourceManifest,
  TASK_GRAPH_SOURCE_RESULT_STATES,
  TASK_GRAPH_SOURCE_ROLES,
  TASK_GRAPH_SOURCE_ROLE_RESULT_STATUSES,
  TASK_GRAPH_SOURCE_TASK_STATUSES,
  type TaskGraphSourceResultState,
  type TaskGraphSourceRole,
  type TaskGraphSourceRoleResultStatus,
  type TaskGraphSourceTaskStatus,
} from '@/lib/agent/session/final-task-graph-source-manifest'
import { taskGraphPlanLabel, type TaskGraphPlanLabelKey } from '@/lib/task-graph-plan-labels'
import { TaskGraphVerificationSummary } from './TaskGraphVerificationSummary'

export interface FinalTaskGraphSourceDetail {
  readonly goal: string
  readonly role: TaskGraphSourceRole
  readonly taskStatus: TaskGraphSourceTaskStatus
  readonly resultState: TaskGraphSourceResultState
  readonly roleResultStatus?: TaskGraphSourceRoleResultStatus
  readonly verification: TaskGraphVerificationDisplayNode
}

type RequestIdentity = Readonly<{ sessionId: string; finalItemId: string; sourceKey: string }>
type RequestState = RequestIdentity & (Readonly<{ state: 'loading' | 'unavailable' }> | Readonly<{
  state: 'ready'; detail: FinalTaskGraphSourceDetail
}>)

export function FinalTaskGraphSources({ content, sessionId, finalItemId, lang }: {
  readonly content: unknown
  readonly sessionId: string
  readonly finalItemId: string
  readonly lang: Lang
}) {
  const manifest = parseFinalTaskGraphSourceManifest(record(content)?.taskGraphSources)
  const disclosureId = React.useId()
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null)
  const [request, setRequest] = React.useState<RequestState | null>(null)

  React.useEffect(() => {
    if (!selectedKey) return
    const controller = new AbortController()
    const identity = { sessionId, finalItemId, sourceKey: selectedKey }
    setRequest({ ...identity, state: 'loading' })
    void loadFinalTaskGraphSourceDetail(identity, controller.signal).then(next => {
      if (next && !controller.signal.aborted) setRequest(next)
    })
    return () => controller.abort()
  }, [finalItemId, selectedKey, sessionId])

  if (!manifest) return null
  const label = (key: TaskGraphPlanLabelKey) => taskGraphPlanLabel(lang, key)
  const selected = manifest.sources.find(source => source.sourceKey === selectedKey)
  const activeRequest = selected && requestMatchesIdentity(request, { sessionId, finalItemId, sourceKey: selected.sourceKey }) ? request : null
  return <section aria-label={label('agent.taskGraph.sources.title')} data-agent-related-task-sources="true" style={sectionStyle}>
    <h3 style={headingStyle}>{label('agent.taskGraph.sources.title')}</h3>
    <p style={noteStyle}>{label('agent.taskGraph.sources.disclaimer')}</p>
    <ul style={listStyle}>{manifest.sources.map(source => {
      const isSelected = selectedKey === source.sourceKey
      return <li key={source.nodeIndex}>
        <button type="button" aria-expanded={isSelected} aria-controls={`task-graph-source-detail-${disclosureId}-${source.nodeIndex}`}
          onClick={() => setSelectedKey(isSelected ? null : source.sourceKey)} style={buttonStyle}>
          {label(roleLabel(source.role))} · {label(statusLabel(source.taskStatus))} · {label(resultLabel(source.resultState))}
        </button>
        {isSelected && <div id={`task-graph-source-detail-${disclosureId}-${source.nodeIndex}`} data-task-graph-source-detail="true" aria-busy={activeRequest?.state === 'loading'}>
          {!activeRequest || activeRequest.state === 'loading'
            ? <p role="status">{label('agent.taskGraph.sources.loading')}</p>
            : activeRequest.state === 'ready'
              ? <SourceDetail detail={activeRequest.detail} lang={lang} />
              : <p role="status">{label('agent.taskGraph.sources.unavailable')}</p>}
        </div>}
      </li>
    })}</ul>
  </section>
}

export async function loadFinalTaskGraphSourceDetail(identity: RequestIdentity, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<RequestState | null> {
  try {
    const response = await fetcher(finalTaskGraphSourceDetailUrl(identity.sessionId, identity.finalItemId, identity.sourceKey), { signal })
    if (!response.ok) throw new Error('unavailable')
    const body = await response.json()
    if (signal.aborted) return null
    const detail = parseFinalTaskGraphSourceDetailResponse(body)
    if (!detail) throw new Error('unavailable')
    return { ...identity, state: 'ready', detail }
  } catch {
    return signal.aborted ? null : { ...identity, state: 'unavailable' }
  }
}

export function requestMatchesIdentity(request: RequestState | null,
  identity: RequestIdentity): request is RequestState {
  return request?.sessionId === identity.sessionId && request.finalItemId === identity.finalItemId
    && request.sourceKey === identity.sourceKey
}

function SourceDetail({ detail, lang }: { detail: FinalTaskGraphSourceDetail; lang: Lang }) {
  const label = (key: TaskGraphPlanLabelKey) => taskGraphPlanLabel(lang, key)
  return <div style={detailStyle}>
    <p><strong>{label('agent.taskGraph.sources.goal')}:</strong> {detail.goal}</p>
    {detail.roleResultStatus && <p><strong>{label('agent.taskGraph.sources.result')}:</strong> {label(resultStatusLabel(detail.roleResultStatus))}</p>}
    <TaskGraphVerificationSummary node={detail.verification} lang={lang} />
  </div>
}

export function parseFinalTaskGraphSourceDetailResponse(value: unknown): FinalTaskGraphSourceDetail | null {
  const root = record(value), task = root ? record(root.task) : null
  if (!root || !exactKeys(root, ['task']) || !task) return null
  const keys = Object.hasOwn(task, 'roleResultStatus')
    ? ['goal', 'resultState', 'role', 'roleResultStatus', 'taskStatus', 'verification']
    : ['goal', 'resultState', 'role', 'taskStatus', 'verification']
  if (!exactKeys(task, keys) || typeof task.goal !== 'string' || !task.goal.trim() || task.goal.length > 240 || task.goal.trim() !== task.goal
    || !oneOf(task.role, TASK_GRAPH_SOURCE_ROLES) || !oneOf(task.taskStatus, TASK_GRAPH_SOURCE_TASK_STATUSES)
    || !oneOf(task.resultState, TASK_GRAPH_SOURCE_RESULT_STATES)
    || Object.hasOwn(task, 'roleResultStatus') && !oneOf(task.roleResultStatus, TASK_GRAPH_SOURCE_ROLE_RESULT_STATUSES)
    || !coherent(task as unknown as FinalTaskGraphSourceDetail)) return null
  const verification = parseTaskGraphVerificationSummary({ schemaVersion: 1, nodes: [task.verification] }, 1)?.nodes[0]
  if (verification === undefined) return null
  return { goal: task.goal, role: task.role as TaskGraphSourceRole, taskStatus: task.taskStatus as TaskGraphSourceTaskStatus,
    resultState: task.resultState as TaskGraphSourceResultState,
    ...(task.roleResultStatus ? { roleResultStatus: task.roleResultStatus as TaskGraphSourceRoleResultStatus } : {}), verification }
}

export function finalTaskGraphSourceDetailUrl(sessionId: string, finalItemId: string, sourceKey: string): string {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/final-items/${encodeURIComponent(finalItemId)}/task-graph-sources/${encodeURIComponent(sourceKey)}`
}

function coherent(source: FinalTaskGraphSourceDetail): boolean {
  const terminal = ['completed', 'failed', 'interrupted', 'cancelled', 'closed'].includes(source.taskStatus)
  const nonterminal = ['queued', 'running', 'retrying', 'waiting', 'waiting_for_user'].includes(source.taskStatus)
  if (source.resultState === 'valid') return source.role !== 'unsupported' && terminal && source.roleResultStatus !== undefined
    && ((source.role === 'writer' || source.role === 'reviewer') ? source.roleResultStatus === 'completed' : true)
  if (source.roleResultStatus !== undefined) return false
  if (source.resultState === 'unsupported_role') return source.role === 'unsupported'
  if (source.role === 'unsupported') return false
  return source.resultState === 'not_terminal' ? nonterminal : terminal
}

function roleLabel(role: TaskGraphSourceRole): TaskGraphPlanLabelKey { return `agent.taskGraph.sources.role.${role}` }
function statusLabel(status: TaskGraphSourceTaskStatus): TaskGraphPlanLabelKey {
  return status === 'waiting_for_user' ? 'agent.taskGraph.status.waitingForUser' : `agent.taskGraph.status.${status}`
}
function resultLabel(state: TaskGraphSourceResultState): TaskGraphPlanLabelKey { return `agent.taskGraph.sources.resultState.${state}` }
function resultStatusLabel(status: TaskGraphSourceRoleResultStatus): TaskGraphPlanLabelKey { return `agent.taskGraph.sources.resultStatus.${status}` }

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try { const keys = Reflect.ownKeys(value); return keys.length === expected.length && keys.every(key => typeof key === 'string'
    && expected.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')) } catch { return false }
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null } catch { return null }
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === 'string' && values.includes(value as T) }

const sectionStyle: React.CSSProperties = { display: 'grid', gap: 6, marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11 }
const headingStyle: React.CSSProperties = { margin: 0, color: 'var(--text)', fontSize: 12 }
const noteStyle: React.CSSProperties = { margin: 0, lineHeight: 1.4 }
const listStyle: React.CSSProperties = { display: 'grid', gap: 4, margin: 0, paddingLeft: 18 }
const buttonStyle: React.CSSProperties = { border: 0, padding: 0, background: 'transparent', color: 'var(--primary)', textAlign: 'left', cursor: 'pointer', font: 'inherit' }
const detailStyle: React.CSSProperties = { display: 'grid', gap: 4, padding: '6px 0', color: 'var(--text)', overflowWrap: 'anywhere' }
