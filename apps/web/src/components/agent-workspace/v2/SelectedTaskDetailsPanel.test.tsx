import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ lang: 'en', t: (key: string) => key }),
}))

import { SelectedTaskDetailsPanel, selectAuthorizedWaitTarget } from './SelectedTaskDetailsPanel'
import type { ChildWorkerTask } from './ChildWorkerAttachView'
import type { TimelineItem } from './timeline-reducer'
import type { SupervisorTurnSummary } from './task-tree-projection'
import type { TaskTreeNode } from './types'

const child: ChildWorkerTask = {
  id: 'child-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', parentTaskId: 'root-1',
  role: 'researcher', taskType: 'research', status: 'running', goal: 'Research roles', hasResult: false, attemptCount: 2,
}
const turn: SupervisorTurnSummary = {
  id: 'turn-1', sessionId: 'session-1', source: 'message', goal: 'Find roles', status: 'in_progress', revision: 1,
  activeStepId: null, finalItemId: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', completedAt: null,
}
const node: TaskTreeNode = { id: 'task:child-1', kind: 'task', label: 'Research roles', status: 'running' }
const item: TimelineItem = {
  schemaVersion: 'agent-harness.v2', id: 'worker-item', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: 'child-1',
  type: 'agent_message', status: 'completed', phase: 'commentary', revision: 1, content: { parts: [{ type: 'text', text: 'worker update' }] },
  startedAt: null, completedAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', source: 'replay', sequence: null,
}

describe('SelectedTaskDetailsPanel', () => {
  it('keeps worker activity and interrupt controls beside the read-only wait card', () => {
    const html = renderToStaticMarkup(<SelectedTaskDetailsPanel
      sessionId="session-1" selectedNode={node} selectedWorker={child} selectedTurn={turn} selectedItem={item}
      tasks={[child]} turns={[turn]} items={[item]} treeNodes={[node, { id: 'task:target-1', kind: 'task', label: 'Target', status: 'queued' }]}
      lifecycleRevision={4} onSelectNode={vi.fn()} onReturnToCurrent={vi.fn()}
      onAccepted={vi.fn()} onConflict={vi.fn()}
    />)
    expect(html).toContain('data-agent-supervisor-selection="true"')
    expect(html).toContain('data-agent-task-wait-details="true"')
    expect(html).toContain('Checking child wait')
    expect(html).toContain('data-child-worker-attach="true"')
    expect(html).toContain('Send follow-up')
    expect(html).toContain('Interrupt task and descendants')
  })

  it('selects a target only when its task node is still in the current tree', () => {
    const onSelect = vi.fn()
    selectAuthorizedWaitTarget('target-1', new Set(['target-1']), onSelect)
    selectAuthorizedWaitTarget('foreign-1', new Set(['target-1']), onSelect)
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('task:target-1')
  })
})
