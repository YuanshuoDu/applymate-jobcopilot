'use client'

import React from 'react'

export type DragHandleProps = {
  draggable:   true
  onDragStart: (e: React.DragEvent) => void
}

export function SectionHeader({ title, count, collapsed, onToggle, onAdd, addLabel, onRemove, dragHandleProps }: {
  title:            string
  count?:           number
  collapsed:        boolean
  onToggle:         () => void
  onAdd?:           () => void
  addLabel?:        string
  onRemove?:        () => void
  dragHandleProps?: DragHandleProps
}) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 500, color: 'var(--text)',
      borderBottom: '0.5px solid var(--border)',
      paddingBottom: 4, marginBottom: 8,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {dragHandleProps && (
          <span
            {...dragHandleProps}
            title="Drag to reorder"
            style={{ color: 'var(--border)', fontSize: 13, cursor: 'grab', userSelect: 'none', lineHeight: 1, marginRight: 1 }}>
            ⠿
          </span>
        )}
        {title}
        {count !== undefined && count > 0 && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>({count})</span>
        )}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {!collapsed && onAdd && (
          <button onClick={e => { e.stopPropagation(); onAdd() }}
            style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer' }}>
            + {addLabel ?? 'Add'}
          </button>
        )}
        {onRemove && (
          <button onClick={e => { e.stopPropagation(); onRemove() }} title="Remove section"
            style={{ fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}>
            ×
          </button>
        )}
        <button onClick={e => { e.stopPropagation(); onToggle() }}
          style={{ fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}>
          {collapsed ? '▶' : '▼'}
        </button>
      </div>
    </div>
  )
}
