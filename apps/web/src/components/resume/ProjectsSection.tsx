'use client'

import { useState, useRef } from 'react'
import { Btn } from '@/components/ui'
import type { ResumeContent } from '@/lib/types'
import { InlineInput } from './InlineInput'
import { SectionHeader, type DragHandleProps } from './SectionHeader'
import { AiFieldSuggestion, type AiFieldContext } from './AiFieldSuggestion'

type Project = NonNullable<ResumeContent['projects']>[number]

export function ProjectsSection({ projects, jobContext, onChange, dragHandleProps, onRemove, flashField }: {
  projects:         Project[]
  jobContext?:      AiFieldContext
  onChange:         (p: Project[]) => void
  flashField?:      string
  dragHandleProps?: DragHandleProps
  onRemove?:        () => void
}) {
  const [editIdx,   setEditIdx]   = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [dragOver,  setDragOver]  = useState<number | null>(null)
  const dragIdx = useRef<number | null>(null)

  function handleDrop(i: number) {
    const from = dragIdx.current
    if (from === null || from === i) { setDragOver(null); return }
    const next = [...projects]; const [item] = next.splice(from, 1); next.splice(i, 0, item)
    onChange(next); dragIdx.current = null; setDragOver(null)
  }

  function addProject() {
    const next = [...projects, { name: '', bullets: [] }]
    onChange(next); setEditIdx(next.length - 1)
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <SectionHeader
        title="PROJECTS"
        count={projects.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(v => !v)}
        onAdd={addProject}
        onRemove={onRemove}
        dragHandleProps={dragHandleProps}
      />

      {!collapsed && (
        <>
          {projects.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 4px' }}>No projects added yet.</div>
          )}

          {projects.map((p, i) => (
            editIdx === i ? (
              <div key={i} style={{ border: '0.5px solid var(--primary)', borderRadius: 6, padding: 10, marginBottom: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                  <InlineInput value={p.name}    onChange={v => { const n=[...projects]; n[i]={...n[i],name:v};    onChange(n) }} placeholder="Project Name" />
                  <InlineInput value={p.role??''} onChange={v => { const n=[...projects]; n[i]={...n[i],role:v||undefined}; onChange(n) }} placeholder="Your Role (optional)" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                  <InlineInput value={p.period??''} onChange={v => { const n=[...projects]; n[i]={...n[i],period:v||undefined}; onChange(n) }} placeholder="Period (optional)" />
                  <InlineInput value={p.url??''}    onChange={v => { const n=[...projects]; n[i]={...n[i],url:v||undefined};   onChange(n) }} placeholder="URL (optional)" />
                </div>
                <div>
                  {p.bullets.map((b, bi) => (
                    <div key={bi} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'flex-start' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 7, flexShrink: 0 }}>•</span>
                      <InlineInput value={b} onChange={v => {
                        const n=[...projects]; n[i]={...n[i],bullets:n[i].bullets.map((x,xi)=>xi===bi?v:x)}; onChange(n)
                      }} multiline placeholder="Describe what you built…" style={{ minHeight: 36 }} />
                      <button onClick={() => { const n=[...projects]; n[i]={...n[i],bullets:n[i].bullets.filter((_,xi)=>xi!==bi)}; onChange(n) }}
                        style={{ fontSize: 11, color: 'var(--c-danger)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 7, flexShrink: 0 }}>✕</button>
                    </div>
                  ))}
                  {p.bullets.map((b, bi) => bi === p.bullets.length - 1 && (
                    <AiFieldSuggestion key={`ai-${bi}`}
                      fieldType="bullet"
                      currentValue={b}
                      context={{ ...jobContext, sectionTitle: `${p.name}${p.role ? ' — ' + p.role : ''}` }}
                      onApply={v => { const n=[...projects]; n[i]={...n[i],bullets:n[i].bullets.map((x,xi)=>xi===bi?v:x)}; onChange(n) }}
                    />
                  ))}
                  <button onClick={() => { const n=[...projects]; n[i]={...n[i],bullets:[...n[i].bullets,'']}; onChange(n) }}
                    style={{ fontSize: 10, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 4 }}>
                    + Add bullet
                  </button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                  <button onClick={() => { onChange(projects.filter((_,xi)=>xi!==i)); setEditIdx(null) }}
                    style={{ fontSize: 10, color: 'var(--c-danger)', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                  <Btn small variant="primary" onClick={() => setEditIdx(null)}>Done</Btn>
                </div>
              </div>
            ) : (
              <div key={i}
                draggable onDragStart={() => { dragIdx.current = i }}
                onDragOver={e => { e.preventDefault(); setDragOver(i) }}
                onDragLeave={() => setDragOver(null)}
                onDrop={() => handleDrop(i)}
                style={{ display: 'flex', gap: 4, cursor: 'pointer', padding: '4px 4px 4px 0', borderRadius: 4, marginBottom: 10,
                  border: dragOver===i ? '0.5px dashed var(--primary)' : '0.5px solid transparent',
                  background: dragOver===i ? 'rgba(24,95,165,0.03)' : 'transparent' }}
                onMouseEnter={e => { if(dragOver!==i)(e.currentTarget as HTMLDivElement).style.background='var(--bg-secondary)' }}
                onMouseLeave={e => { if(dragOver!==i)(e.currentTarget as HTMLDivElement).style.background='transparent' }}>
                <span style={{ fontSize: 13, color: 'var(--border)', cursor: 'grab', marginTop: 2, flexShrink: 0, userSelect: 'none' }}>⠿</span>
                <div style={{ flex: 1 }} onClick={() => setEditIdx(i)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <div>
                      <span style={{ fontSize: 12, fontWeight: 500 }}>{p.name || <em style={{ color: 'var(--text-muted)' }}>Untitled</em>}</span>
                      {p.role && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}> · {p.role}</span>}
                      {p.url && <a href={p.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: 10, color: 'var(--primary)', marginLeft: 8 }}>↗ link</a>}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.period}</span>
                  </div>
                  <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    {p.bullets.filter(Boolean).map((b, j) => (
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
