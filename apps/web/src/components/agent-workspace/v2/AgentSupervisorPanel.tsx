'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'

import { flattenTaskTree, TaskTreePanel } from './TaskTreePanel'
import { projectSupervisorTree, type SupervisorTaskSummary, type SupervisorTurnSummary } from './task-tree-projection'
import type { AgentTimelineSnapshot } from './use-agent-timeline'

interface PageInfo { hasMore?: boolean; nextCursor?: string | null }
interface TurnsResponse { turns?: SupervisorTurnSummary[]; page?: PageInfo }
interface TasksResponse { tasks?: SupervisorTaskSummary[]; page?: PageInfo }

export interface AgentSupervisorPanelProps {
  readonly sessionId: string | null
  readonly timeline: AgentTimelineSnapshot
}

/** Read-only V2 evidence panel. Commands remain owned by the composer. */
export function AgentSupervisorPanel({ sessionId, timeline }: AgentSupervisorPanelProps) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [extraTurns, setExtraTurns] = useState<SupervisorTurnSummary[]>([])
  const [extraTasks, setExtraTasks] = useState<SupervisorTaskSummary[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const encodedSessionId = sessionId ? encodeURIComponent(sessionId) : ''
  const turnsQuery = useApi<TurnsResponse>(
    sessionId ? `/api/agent/sessions/${encodedSessionId}/turns?limit=100` : '',
    { enabled: Boolean(sessionId) },
  )
  const tasksQuery = useApi<TasksResponse>(
    sessionId ? `/api/agent/sessions/${encodedSessionId}/tasks?limit=100` : '',
    { enabled: Boolean(sessionId) },
  )
  const previousLifecycleKey = useRef<string | null>(null)
  const sessionEpochRef = useRef(0)

  useEffect(() => {
    sessionEpochRef.current += 1
    setSelectedId(undefined)
    setExtraTurns([])
    setExtraTasks([])
    setLoadMoreError(null)
    previousLifecycleKey.current = null
  }, [sessionId])

  const turns = useMemo(() => (sessionId ? [...(turnsQuery.data?.turns ?? []), ...extraTurns].filter(turn => turn.sessionId === sessionId) : []), [sessionId, turnsQuery.data, extraTurns])
  const tasks = useMemo(() => (sessionId ? [...(tasksQuery.data?.tasks ?? []), ...extraTasks].filter(task => task.sessionId === sessionId) : []), [sessionId, tasksQuery.data, extraTasks])
  const lifecycleKey = String(timeline.lifecycleRevision)

  const { data: turnsData, refetch: refetchTurns } = turnsQuery
  const { data: tasksData, refetch: refetchTasks } = tasksQuery
  const turnsPage = turnsQuery.data?.page
  const tasksPage = tasksQuery.data?.page
  const hasMore = Boolean(turnsPage?.hasMore || tasksPage?.hasMore)

  const loadMore = useCallback(async () => {
    if (!sessionId || loadingMore || !hasMore) return
    const epoch = sessionEpochRef.current
    setLoadingMore(true)
    setLoadMoreError(null)
    try {
      const requests: Array<{ kind: 'turns' | 'tasks'; cursor: string }> = []
      if (turnsPage?.hasMore && turnsPage.nextCursor) requests.push({ kind: 'turns', cursor: turnsPage.nextCursor })
      if (tasksPage?.hasMore && tasksPage.nextCursor) requests.push({ kind: 'tasks', cursor: tasksPage.nextCursor })
      const responses = await Promise.all(requests.map(async request => {
        const query = new URLSearchParams({ limit: '100', cursor: request.cursor })
        const response = await fetch(`/api/agent/sessions/${encodedSessionId}/${request.kind}?${query}`)
        const body = await response.json().catch(() => null) as unknown
        if (!response.ok) throw new Error(`${request.kind} page failed (${response.status})`)
        return { kind: request.kind, body }
      }))
      if (epoch !== sessionEpochRef.current) return
      for (const response of responses) {
        if (response.kind === 'turns') {
          const body = response.body as TurnsResponse
          setExtraTurns(current => [...current, ...(body.turns ?? [])])
        } else {
          const body = response.body as TasksResponse
          setExtraTasks(current => [...current, ...(body.tasks ?? [])])
        }
      }
    } catch (reason) {
      if (epoch === sessionEpochRef.current) setLoadMoreError(reason instanceof Error ? reason.message : 'Could not load more supervisor records')
    } finally {
      if (epoch === sessionEpochRef.current) setLoadingMore(false)
    }
  }, [encodedSessionId, hasMore, loadingMore, sessionId, tasksPage?.hasMore, tasksPage?.nextCursor, turnsPage?.hasMore, turnsPage?.nextCursor])

  useEffect(() => {
    if (!sessionId) return
    if (previousLifecycleKey.current === null) {
      previousLifecycleKey.current = lifecycleKey
      return
    }
    if (previousLifecycleKey.current === lifecycleKey) return
    previousLifecycleKey.current = lifecycleKey
    if (turnsData || tasksData) {
      refetchTurns()
      refetchTasks()
    }
  }, [lifecycleKey, sessionId, tasksData, turnsData, refetchTasks, refetchTurns])

  const nodes = useMemo(() => projectSupervisorTree({
    turns,
    items: timeline.items,
    tasks,
    labels: { task: t('agent.tasks'), step: t('agent.plan'), tool: t('agent.toolActor') },
  }), [t, turns, timeline.items, tasks])
  const selectedNode = useMemo(() => flattenTaskTree(nodes).find(node => node.id === selectedId), [nodes, selectedId])
  const selectedItem = selectedNode?.itemId ? timeline.items.find(item => item.id === selectedNode.itemId) : undefined
  const loading = Boolean(sessionId && (timeline.restoring || turnsQuery.loading || tasksQuery.loading))
  const error = timeline.error ?? turnsQuery.error ?? tasksQuery.error

  if (!sessionId) return null

  return (
    <aside className="agent-supervisor-panel" aria-label={t('agent.tasks')} data-agent-supervisor-panel="true">
      <style>{`
        .agent-supervisor-panel {
          width: min(310px, 30vw);
          min-width: 260px;
          min-height: 0;
          overflow-y: auto;
          padding: 14px;
          border-left: 1px solid var(--border);
          background: var(--bg-tertiary);
        }
        .agent-supervisor-selection {
          display: grid;
          gap: 8px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid var(--border);
        }
        @media (max-width: 900px) {
          .agent-supervisor-panel {
            width: auto;
            min-width: 0;
            max-height: 42vh;
            border-left: 0;
            border-top: 1px solid var(--border);
          }
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>{t('agent.tasks')}</h2>
        <span data-agent-supervisor-connection={timeline.connection} style={{ color: 'var(--text-muted)', fontSize: 10 }}>
          {connectionLabel(timeline.connection, t)}
        </span>
      </div>
      {loading && <p aria-live="polite" style={messageStyle}>{t('agent.loadingTasks')}</p>}
      {error && <p role="alert" style={{ ...messageStyle, color: 'var(--c-danger)' }}>{t('agent.supervisorUnavailable')}</p>}
      {!loading && !nodes.length && !error && <p style={messageStyle}>{t('agent.noTaskRecords')}</p>}
      {!!nodes.length && <TaskTreePanel nodes={nodes} selectedId={selectedId} sessionKey={sessionId} showHeading={false} onSelect={setSelectedId} />}
      {hasMore && <button type="button" onClick={() => void loadMore()} disabled={loadingMore} style={loadMoreStyle}>
        {loadingMore ? t('agent.loadingMoreSupervisorRecords') : t('agent.loadMoreSupervisorRecords')}
      </button>}
      {loadMoreError && <p role="alert" style={{ ...messageStyle, color: 'var(--c-danger)' }}>{t('agent.loadMoreFailed')}</p>}
      {selectedNode && (
        <section className="agent-supervisor-selection" aria-label={selectedNode.label} data-agent-supervisor-selection="true">
          <div style={{ display: 'grid', gap: 4 }}>
            <strong style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{selectedNode.label}</strong>
            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{t('agent.status')}: {statusLabel(selectedNode.status, t)}</span>
            {selectedNode.detail && <span style={{ color: 'var(--c-danger)', fontSize: 10, overflowWrap: 'anywhere' }}>{selectedNode.detail}</span>}
            {selectedNode.resultAvailable && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{t('agent.toolResult')}</span>}
          </div>
          {selectedItem && <EvidenceSummary item={selectedItem} t={t} />}
        </section>
      )}
    </aside>
  )
}

function EvidenceSummary({ item, t }: { item: NonNullable<AgentTimelineSnapshot['items']>[number]; t: (key: string) => string }) {
  return (
    <div data-agent-supervisor-evidence="true" style={{ display: 'grid', gap: 4, paddingTop: 8, color: 'var(--text-muted)', fontSize: 10 }}>
      <span>{t('agent.type')}: {itemTypeLabel(item.type, t)}</span>
      <span>{t('agent.itemStatus')}: {statusLabel(item.status, t)}</span>
      {item.completedAt && <span>{t('agent.complete')}: {new Date(item.completedAt).toLocaleString()}</span>}
    </div>
  )
}

function itemTypeLabel(type: string, t: (key: string) => string): string {
  if (type === 'agent_message') return t('agent.messageTitle')
  if (type === 'plan') return t('agent.plan')
  if (type === 'tool_call') return t('agent.toolCall')
  if (type === 'tool_result') return t('agent.toolResult')
  if (type === 'reasoning_summary') return t('agent.reasoningSummary')
  return t('agent.harnessItem')
}

function connectionLabel(connection: AgentTimelineSnapshot['connection'], t: (key: string) => string): string {
  if (connection === 'connected') return t('agent.connected')
  if (connection === 'reconnecting') return t('agent.reconnecting')
  return t('agent.loading')
}

function statusLabel(status: string, t: (key: string) => string): string {
  if (status === 'queued' || status === 'retrying') return t('agent.queuedTasks')
  if (status === 'running' || status === 'in_progress' || status === 'started' || status === 'streaming') return t('agent.running')
  if (status.startsWith('waiting')) return t('agent.waiting')
  if (status === 'completed' || status === 'passed') return t('agent.done')
  if (status === 'failed' || status === 'error') return t('agent.errorTitle')
  if (status === 'interrupted' || status === 'cancelled') return t('agent.toolCancelled')
  if (status === 'paused') return t('agent.paused')
  return t('agent.unknownItem')
}

const messageStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.45 }
const loadMoreStyle: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 7, padding: '7px 9px', background: 'var(--bg)', color: 'var(--primary)', cursor: 'pointer', font: 'inherit', fontSize: 10 }
