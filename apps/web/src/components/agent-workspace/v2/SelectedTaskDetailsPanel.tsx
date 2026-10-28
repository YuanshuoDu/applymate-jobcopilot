'use client'

import React, { useMemo } from 'react'

import { useI18n } from '@/lib/i18n'

import { AgentTurnRetryControl } from './AgentTurnRetryControl'
import { ChildWorkerAttachView, type ChildWorkerTask } from './ChildWorkerAttachView'
import { AgentTaskWaitDetailsCard } from './AgentTaskWaitDetailsCard'
import { EvidenceSummary, statusLabel } from './agent-supervisor-evidence'
import { taskInterruptEventVersion, TaskInterruptControl, flattenTaskTree } from './TaskTreePanel'
import { projectSelectedTaskInterrupt, type SupervisorTurnSummary } from './task-tree-projection'
import type { TimelineItem } from './timeline-reducer'
import type { TaskTreeNode } from './types'

export interface SelectedTaskDetailsPanelProps {
  readonly sessionId: string
  readonly selectedNode: TaskTreeNode | undefined
  readonly selectedWorker: ChildWorkerTask | null
  readonly selectedTurn: SupervisorTurnSummary | null
  readonly selectedItem: TimelineItem | undefined
  readonly tasks: readonly ChildWorkerTask[]
  readonly turns: readonly SupervisorTurnSummary[]
  readonly items: readonly TimelineItem[]
  readonly treeNodes: readonly TaskTreeNode[]
  readonly lifecycleRevision: number
  readonly onSelectNode: (id: string) => void
  readonly onReturnToCurrent: () => void
  readonly onAccepted: () => void
  readonly onConflict: () => void | Promise<void>
}

export function SelectedTaskDetailsPanel(props: SelectedTaskDetailsPanelProps) {
  const { t } = useI18n()
  const { selectedNode, selectedWorker } = props
  const taskNodeIds = useMemo(() => new Set(flattenTaskTree(props.treeNodes)
    .filter(node => node.kind === 'task').map(node => node.id.slice('task:'.length))), [props.treeNodes])
  if (!selectedNode) return null
  const interrupt = projectSelectedTaskInterrupt(props.tasks, props.turns, selectedNode, props.items)
  const interruptVersion = interrupt ? taskInterruptEventVersion(props.items, interrupt.task.id) : null
  const selectedTaskId = selectedNode.kind === 'task' ? selectedNode.id.slice('task:'.length) : undefined
  const selectTarget = (taskId: string) => selectAuthorizedWaitTarget(taskId, taskNodeIds, props.onSelectNode)

  return (
    <section className="agent-supervisor-selection" aria-label={selectedNode.label} data-agent-supervisor-selection="true">
      <div style={{ display: 'grid', gap: 4 }}>
        <strong style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{selectedNode.label}</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{t('agent.status')}: {statusLabel(selectedNode.status, t)}</span>
        {selectedNode.detail && <span style={{ color: 'var(--c-danger)', fontSize: 10, overflowWrap: 'anywhere' }}>{selectedNode.detail}</span>}
        {selectedNode.resultAvailable && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{t('agent.toolResult')}</span>}
      </div>
      {selectedWorker && <AgentTaskWaitDetailsCard
        key={`${props.sessionId}:${selectedWorker.id}`} sessionId={props.sessionId} parent={selectedWorker}
        lifecycleRevision={props.lifecycleRevision} selectedTaskId={selectedTaskId} taskNodeIds={taskNodeIds}
        onSelectTarget={selectTarget}
      />}
      {selectedWorker?.parentTaskId && selectedWorker.id !== selectedWorker.rootTaskId
        ? <ChildWorkerAttachView key={`attach:${selectedWorker.id}`} sessionId={props.sessionId} task={selectedWorker} items={props.items} onClose={props.onReturnToCurrent} onConflict={props.onConflict} />
        : props.selectedItem && <EvidenceSummary item={props.selectedItem} t={t} />}
      <AgentTurnRetryControl sessionId={props.sessionId} turn={props.selectedTurn} onAccepted={props.onAccepted} />
      {interrupt && <TaskInterruptControl
        sessionId={props.sessionId} taskId={interrupt.task.id} taskLabel={selectedNode.label}
        eligible={interrupt.eligible} status={interrupt.status} statusVersion={interruptVersion} onAccepted={props.onAccepted}
      />}
    </section>
  )
}

export function selectAuthorizedWaitTarget(taskId: string, taskNodeIds: ReadonlySet<string>, onSelectNode: (id: string) => void): void {
  if (taskNodeIds.has(taskId)) onSelectNode(`task:${taskId}`)
}
