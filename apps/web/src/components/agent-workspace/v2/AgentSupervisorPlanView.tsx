'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'

import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import { taskGraphPlanLabel } from '@/lib/task-graph-plan-labels'

import { TaskGraphPlanPanel } from './TaskGraphPlanPanel'
import type { SelectedJobBatchCommandResult } from './selected-job-batch-command'
import type { VerifiedShortlistPreparationRequest } from './VerifiedShortlistPreparation'
import { resolveCurrentSelectedJobBatchTurn, SelectedJobBatchPlanProgress } from './SelectedJobBatchPlanProgress'
import { buildTaskGraphTaskLookupUrl, resolveTaskGraphPlanInspectionSelection, selectedTaskGraphIdentity, type TaskGraphIdentity } from './task-graph-plan-query'
import type { SupervisorTaskSummary, SupervisorTurnSummary } from './task-tree-projection'
import type { TimelineItem } from './timeline-reducer'
import type { TaskTreeNode } from './types'

interface TaskResponse {
  readonly tasks?: SupervisorTaskSummary[]
  readonly planLedger?: unknown
  readonly discoveryShortlist?: unknown
}

export type SupervisorNodeSelection = { readonly sessionId: string; readonly id: string }

export function supervisorPlanSelectionControls(
  state: SupervisorNodeSelection | null,
  sessionId: string | null,
  setState: (selection: SupervisorNodeSelection | null) => void,
) {
  return {
    selectedId: state?.sessionId === sessionId ? state.id : undefined,
    onSelect: (id: string) => { if (sessionId) setState({ sessionId, id }) },
    onReturnToCurrent: () => setState(null),
  }
}

export function AgentSupervisorPlanView({
  sessionId, items, turns, tasks, selectedNodeId, selectedNode, currentGraphTasks,
  currentLedger, currentDiscoveryShortlist, currentPreparationTurnId, activeTurnProjection, lifecycleRevision,
  onPrepareBatch, onReturnToCurrent,
}: {
  readonly sessionId: string
  readonly items: readonly TimelineItem[]
  readonly turns: readonly SupervisorTurnSummary[]
  readonly tasks: readonly SupervisorTaskSummary[]
  readonly selectedNodeId?: string
  readonly selectedNode?: TaskTreeNode
  readonly currentGraphTasks: readonly SupervisorTaskSummary[]
  readonly currentLedger?: unknown
  readonly currentDiscoveryShortlist?: unknown
  readonly currentPreparationTurnId: string | null
  readonly activeTurnProjection?: unknown
  readonly lifecycleRevision: number
  readonly onPrepareBatch?: (request: VerifiedShortlistPreparationRequest) => Promise<SelectedJobBatchCommandResult>
  readonly onReturnToCurrent: () => void
}) {
  const { lang, t } = useI18n()
  const selection = resolveTaskGraphPlanInspectionSelection({ sessionId, selectedNodeId, selectedNode, turns, tasks, items })
  const turnId = selection.kind === 'selected' ? selection.turnId : null
  const currentBatch = resolveCurrentSelectedJobBatchTurn(turns, sessionId, activeTurnProjection)
  const planTurnId = selection.kind === 'selected' ? turnId : currentPreparationTurnId
  const planIdentity = selectedTaskGraphIdentity(items, sessionId, planTurnId)
  const selectionIdentity = JSON.stringify([sessionId, selection.kind, selectedNodeId ?? null, turnId,
    planIdentity?.graphItemId ?? null, planIdentity?.rootTaskId ?? null, planIdentity?.revision ?? null])
  const selectionEpoch = useRef({ identity: selectionIdentity, value: 0 })
  if (selectionEpoch.current.identity !== selectionIdentity) {
    selectionEpoch.current = { identity: selectionIdentity, value: selectionEpoch.current.value + 1 }
  }
  const selectionKey = JSON.stringify([selectionIdentity, selectionEpoch.current.value])
  const currentSelectionKey = useRef(selectionKey)
  currentSelectionKey.current = selectionKey
  const [batchFocus, setBatchFocus] = useState<{ turnId: string; selectionKey: string } | null>(null)
  const focusBatch = (newTurnId: string) => {
    if (currentSelectionKey.current === selectionKey) setBatchFocus({ turnId: newTurnId, selectionKey })
  }
  const focusedBatchTurnId = batchFocus?.selectionKey === selectionKey ? batchFocus.turnId : null
  const selectedTurn = turnId ? turns.find(candidate => candidate.sessionId === sessionId && candidate.id === turnId) : null
  const batchTurnId = focusedBatchTurnId ?? (selection.kind === 'current' ? currentBatch.turnId
    : selection.kind === 'selected' && selectedTurn?.selectedJobBatchPreparation === true ? turnId : null
  )
  const batchGraph = batchTurnId ? selectedTaskGraphIdentity(items, sessionId, batchTurnId) : null
  const batchIsActive = Boolean(focusedBatchTurnId || batchTurnId && batchTurnId === currentBatch.activeTurnId)
  const url = useMemo(() => turnId ? buildTaskGraphTaskLookupUrl(sessionId, items, turnId) : null, [items, sessionId, turnId])
  const expected = useMemo(() => turnId ? selectedTaskGraphIdentity(items, sessionId, turnId) : null, [items, sessionId, turnId])
  const historyQuery = useApi<TaskResponse>(url ?? '', { enabled: selection.kind === 'selected' && Boolean(url) })
  const refreshKey = Number.isSafeInteger(lifecycleRevision) && lifecycleRevision >= 0 ? lifecycleRevision : 0
  const lastRefreshKey = useRef(refreshKey)
  useEffect(() => {
    const previous = lastRefreshKey.current
    lastRefreshKey.current = refreshKey
    if (shouldRefetchSelectedPlan(previous, refreshKey, selection.kind, url)) void historyQuery.refetch()
  }, [historyQuery.refetch, refreshKey, selection.kind, url])
  const currentTasks = [...currentGraphTasks.filter(task => task.sessionId === sessionId), ...tasks.filter(task => task.sessionId === sessionId)]

  if (selection.kind === 'current') return <>
    {batchTurnId && <SelectedJobBatchPlanProgress sessionId={sessionId} turnId={batchTurnId} expectedGraph={batchGraph} active={batchIsActive} lifecycleRevision={lifecycleRevision} />}
    <TaskGraphPlanPanel sessionId={sessionId} items={items} tasks={currentTasks} ledger={currentLedger}
      discoveryShortlist={currentDiscoveryShortlist} selectedPreparationTurnId={currentPreparationTurnId} selectionKey={selectionKey}
      onPrepareBatch={onPrepareBatch} onBatchStarted={focusBatch} />
  </>

  const matchingLedger = expected && matchesIdentity(historyQuery.data?.planLedger, expected)
  const unavailable = selection.kind === 'unavailable' || !turnId || !url || !expected
    || Boolean(!historyQuery.loading && !matchingLedger)

  return <section aria-label={taskGraphPlanLabel(lang, 'agent.taskGraph.selectedPlan')} data-agent-plan-inspection="true" data-plan-inspection-state={unavailable ? 'unavailable' : historyQuery.loading && !matchingLedger ? 'loading' : 'selected'}>
    <div style={contextStyle}>
      <div>
        <strong>{taskGraphPlanLabel(lang, 'agent.taskGraph.selectedPlan')}</strong>
        {selectedTurn && <div>{selectedTurn.goal}</div>}
      </div>
      <button type="button" onClick={onReturnToCurrent} style={buttonStyle}>
        {taskGraphPlanLabel(lang, 'agent.taskGraph.returnToCurrentPlan')}
      </button>
    </div>
    {unavailable
      ? <p role="status" style={messageStyle}>{taskGraphPlanLabel(lang, 'agent.taskGraph.planUnavailable')}</p>
      : historyQuery.loading && !matchingLedger
        ? <p role="status" style={messageStyle}>{taskGraphPlanLabel(lang, 'agent.taskGraph.loadingSelectedPlan')}</p>
        : <TaskGraphPlanPanel
          sessionId={sessionId} items={items} tasks={historyQuery.data?.tasks ?? []}
          ledger={historyQuery.data?.planLedger} discoveryShortlist={historyQuery.data?.discoveryShortlist}
          selectedPreparationTurnId={turnId} selectionKey={selectionKey} onPrepareBatch={onPrepareBatch}
          onBatchStarted={focusBatch}
        />}
    {batchTurnId && <SelectedJobBatchPlanProgress sessionId={sessionId} turnId={batchTurnId} expectedGraph={batchGraph} active={batchIsActive} lifecycleRevision={lifecycleRevision} />}
  </section>
}

export function shouldRefetchSelectedPlan(
  previousRevision: number,
  nextRevision: number,
  selection: 'current' | 'selected' | 'unavailable',
  url: string | null,
): boolean {
  return Number.isSafeInteger(previousRevision) && previousRevision >= 0
    && Number.isSafeInteger(nextRevision) && nextRevision >= 0
    && previousRevision !== nextRevision && selection === 'selected' && Boolean(url)
}

function matchesIdentity(value: unknown, expected: TaskGraphIdentity): boolean {
  const ledger = record(value)
  const identity = ledger ? record(ledger.identity) : null
  if (!identity || Object.keys(identity).sort().join(',') !== 'graphItemId,revision,rootTaskId,sessionId,turnId') return false
  return identity.sessionId === expected.sessionId && identity.graphItemId === expected.graphItemId
    && identity.turnId === expected.turnId && identity.rootTaskId === expected.rootTaskId && identity.revision === expected.revision
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

const contextStyle: React.CSSProperties = { display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 8, fontSize: 10, color: 'var(--text-muted)' }
const buttonStyle: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px', background: 'var(--bg)', color: 'var(--primary)', cursor: 'pointer', font: 'inherit' }
const messageStyle: React.CSSProperties = { margin: '8px 0', fontSize: 10, color: 'var(--text-muted)' }
