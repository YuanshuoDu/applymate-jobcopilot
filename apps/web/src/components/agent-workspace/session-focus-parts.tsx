import React from 'react'
import { taskStatusColor, taskStatusLabel, confidenceLabel } from './session-view-model'
import type { WorkspaceTaskNode } from './agent-workspace-projection'

export function FocusTaskTree({ nodes, depth = 0 }: { nodes: WorkspaceTaskNode[]; depth?: number }) {
  return <>{nodes.map(node => {
    const task = node.task
    const color = taskStatusColor(task.status)
    return <React.Fragment key={task.id}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 10px', paddingLeft: 10 + depth * 14, borderTop: depth === 0 ? 'none' : '1px solid var(--border)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, marginTop: 5, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 650, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.role} · {task.taskType}</div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3 }}>{taskStatusLabel(task.status)} · {confidenceLabel(task.confidence ?? null)}</div>
          {task.goal && <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3, whiteSpace: 'normal' }}>{task.goal}</div>}
          {node.orphaned && <div style={{ fontSize: 9, color: '#d97706', marginTop: 3 }}>Parent task unavailable; shown at root.</div>}
          {task.failureReason && <div style={{ fontSize: 9, color: 'var(--c-danger)', marginTop: 3 }}>{task.failureReason}</div>}
        </div>
      </div>
      <FocusTaskTree nodes={node.children} depth={depth + 1} />
    </React.Fragment>
  })}</>
}

export function focusQuestionOptions(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap(option => {
    if (!option || typeof option !== 'object') return []
    const record = option as { label?: unknown; value?: unknown }
    return typeof record.label === 'string' && typeof record.value === 'string' ? [{ label: record.label, value: record.value }] : []
  })
}
