'use client'

import { useState, useRef } from 'react'
import { Btn } from '@/components/ui'
import type { ResumeContent } from '@/lib/types'
import { InlineInput } from './InlineInput'
import { SectionHeader, type DragHandleProps } from './SectionHeader'
import { AiFieldSuggestion, type AiFieldContext } from './AiFieldSuggestion'

type CustomEntry = NonNullable<ResumeContent['custom']>[number]
type CustomItem  = CustomEntry['items'][number]

export function CustomSection({ entry, jobContext, onChange, onRemove, dragHandleProps }: {
  entry:            CustomEntry
  jobContext?:      AiFieldContext
  onChange:         (e: CustomEntry) => void
  onRemove?:        () => void
  dragHandleProps?: DragHandleProps
}) {
  const [editTitle, setEditTitle] = useState(false)
  const [editIdx,   setEditIdx]   = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [dragOver,  setDragOver]  = useState<number | null>(null)
  const dragIdx = useRef<number | null>(null)

  function handleDrop(i: number) {
    const from = dragIdx.current
    if (from === null || from === i) { setDragOver(null); return }
    const items = [...entry.items]; const [item] = items.splice(from, 1); items.splice(i, 0, item)
    onChange({ ...entry, items }); dragIdx.current = null; setDragOver(null)
  }

  function addItem() {
    const items = [...entry.items, { bullets: [''] }]
    onChange({ ...entry, items }); setEditIdx(items.length - 1)
  }

  function updateItem(i: number, patch: Partial<CustomItem>) {
    const items = [...entry.items]; items[i] = { ...items[i], ...patch }; onChange({ ...entry, items })
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <SectionHeader
        title={entry.title || 'CUSTOM SECTION'}
        count={entry.items.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(v => !v)}
        onAdd={addItem}
        onRemove={onRemove}
        dragHandleProps={dragHandleProps}
      />

      {/* Editable section title */}
      {!collapsed && (
        <>
          {editTitle ? (
            <input autoFocus value={entry.title}
              onChange={e => onChange({ ...entry, title: e.target.value.toUpperCase() })}
              onBlur={() => setEditTitle(false)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditTitle(false) }}
              placeholder="SECTION TITLE"
              style={{ fontSize: 11, fontWeight: 500, width: '100%', border: '0.5px solid #185FA5', borderRadius: 4, padding: '3px 6px', outline: 'none', marginBottom: 8, color: 'var(--text)', background: 'var(--bg)', boxSizing: 'border-box' }}
            />
          ) : (
            <button onClick={() => setEditTitle(true)}
              style={{ fontSize: 9, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 6, padding: 0 }}>
              Edit title
            </button>
          )}

          {entry.items.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 4px' }}>No items added yet.</div>
          )}

          {entry.items.map((item, i) => (
            editIdx === i ? (
              <div key={i} style={{ border: '0.5px solid #185FA5', borderRadius: 6, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                  <InlineInput value={item.title??''}    onChange={v => updateItem(i, { title: v||undefined })}    placeholder="Title (optional)" />
                  <InlineInput value={item.subtitle??''} onChange={v => updateItem(i, { subtitle: v||undefined })} placeholder="Subtitle (optional)" />
                </div>
                <InlineInput value={item.period??''} onChange={v => updateItem(i, { period: v||undefined })} placeholder="Period (optional)" style={{ marginBottom: 8 }} />
                <div>
                  {item.bullets.map((b, bi) => (
                    <div key={bi} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'flex-start' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 7, flexShrink: 0 }}>•</span>
                      <InlineInput value={b} onChange={v => {
                        updateItem(i, { bullets: item.bullets.map((x, xi) => xi === bi ? v : x) })
                      }} multiline placeholder="Detail…" style={{ minHeight: 36 }} />
                      <button onClick={() => updateItem(i, { bullets: item.bullets.filter((_, xi) => xi !== bi) })}
                        style={{ fontSize: 11, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer', marginTop: 7, flexShrink: 0 }}>✕</button>
                    </div>
                  ))}
                  {item.bullets.map((b, bi) => bi === item.bullets.length - 1 && (
                    <AiFieldSuggestion key={`ai-${bi}`}
                      fieldType="custom"
                      currentValue={b}
                      context={{ ...jobContext, sectionTitle: `${entry.title}${item.title ? ' — ' + item.title : ''}` }}
                      onApply={v => updateItem(i, { bullets: item.bullets.map((x, xi) => xi === bi ? v : x) })}
                    />
                  ))}
                  <button onClick={() => updateItem(i, { bullets: [...item.bullets, ''] })}
                    style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', marginTop: 4 }}>
                    + Add bullet
                  </button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                  <button onClick={() => { onChange({ ...entry, items: entry.items.filter((_, xi) => xi !== i) }); setEditIdx(null) }}
                    style={{ fontSize: 10, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                  <Btn small variant="primary" onClick={() => setEditIdx(null)}>Done</Btn>
                </div>
              </div>
            ) : (
              <div key={i}
                draggable onDragStart={() => { dragIdx.current = i }}
                onDragOver={e => { e.preventDefault(); setDragOver(i) }}
                onDragLeave={() => setDragOver(null)}
                onDrop={() => handleDrop(i)}
                style={{ display: 'flex', gap: 4, cursor: 'pointer', padding: '4px 4px 4px 0', borderRadius: 4, marginBottom: 8,
                  border: dragOver===i ? '0.5px dashed #185FA5' : '0.5px solid transparent',
                  background: dragOver===i ? 'rgba(24,95,165,0.03)' : 'transparent' }}
                onMouseEnter={e => { if(dragOver!==i)(e.currentTarget as HTMLDivElement).style.background='var(--bg-secondary)' }}
                onMouseLeave={e => { if(dragOver!==i)(e.currentTarget as HTMLDivElement).style.background='transparent' }}>
                <span style={{ fontSize: 13, color: 'var(--border)', cursor: 'grab', marginTop: 2, flexShrink: 0, userSelect: 'none' }}>⠿</span>
                <div style={{ flex: 1 }} onClick={() => setEditIdx(i)}>
                  {(item.title || item.subtitle) && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <div>
                        {item.title    && <span style={{ fontSize: 12, fontWeight: 500 }}>{item.title}</span>}
                        {item.subtitle && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}> · {item.subtitle}</span>}
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.period}</span>
                    </div>
                  )}
                  <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    {item.bullets.filter(Boolean).map((b, j) => (
                      <li key={j} style={{ fontSize: 12, lineHeight: 1.7 }}>{b}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )
          ))}
        </>
      )}
    </div>
  )
}
