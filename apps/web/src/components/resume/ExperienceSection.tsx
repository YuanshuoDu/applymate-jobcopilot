'use client'

import { useState, useRef } from 'react'
import { Btn } from '@/components/ui'
import type { ResumeContent } from '@/lib/types'
import { InlineInput } from './InlineInput'
import { SectionHeader, type DragHandleProps } from './SectionHeader'
import { AiFieldSuggestion, type AiFieldContext } from './AiFieldSuggestion'

export function ExperienceSection({ experience, jobContext, onChange, dragHandleProps, onRemove, flashField }: {
  experience:       ResumeContent['experience']
  jobContext?:      AiFieldContext
  onChange:         (exp: ResumeContent['experience']) => void
  dragHandleProps?: DragHandleProps
  onRemove?:        () => void
  flashField?:      string
}) {
  const [editIdx,   setEditIdx]   = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [dragOver,  setDragOver]  = useState<number | null>(null)
  const dragIdx = useRef<number | null>(null)

  function handleDrop(i: number) {
    const from = dragIdx.current
    if (from === null || from === i) { setDragOver(null); return }
    const next = [...experience]; const [item] = next.splice(from, 1); next.splice(i, 0, item)
    onChange(next); dragIdx.current = null; setDragOver(null)
    if (editIdx !== null) setEditIdx(null)
  }

  function addExp() {
    const next = [...experience, { company: '', role: '', period: '', bullets: [''] }]
    onChange(next); setEditIdx(next.length - 1)
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <SectionHeader
        title="EXPERIENCE"
        count={experience.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(v => !v)}
        onAdd={addExp}
        onRemove={onRemove}
        dragHandleProps={dragHandleProps}
      />

      {!collapsed && (
        <>
          {experience.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 4px' }}>No experience added yet.</div>
          )}

          {experience.map((exp, i) => (
            editIdx === i ? (
              <div key={i} style={{ border: '0.5px solid #185FA5', borderRadius: 6, padding: 10, marginBottom: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                  <InlineInput value={exp.role}    onChange={v => { const n=[...experience]; n[i]={...n[i],role:v};    onChange(n) }} placeholder="Job Title" />
                  <InlineInput value={exp.company} onChange={v => { const n=[...experience]; n[i]={...n[i],company:v}; onChange(n) }} placeholder="Company" />
                </div>
                <InlineInput value={exp.period} onChange={v => { const n=[...experience]; n[i]={...n[i],period:v}; onChange(n) }} placeholder="e.g. Jan 2022 – Present" style={{ marginBottom: 8 }} />
                <div>
                  {exp.bullets.map((b, bi) => (
                    <div key={bi} style={{ marginBottom: 6 }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 7, flexShrink: 0 }}>•</span>
                        <InlineInput value={b} onChange={v => {
                          const n=[...experience]; n[i]={...n[i],bullets:n[i].bullets.map((x,xi)=>xi===bi?v:x)}; onChange(n)
                        }} multiline placeholder="Describe your accomplishment…" style={{ minHeight: 36 }} />
                        <button onClick={() => {
                          const n=[...experience]; n[i]={...n[i],bullets:n[i].bullets.filter((_,xi)=>xi!==bi)}; onChange(n)
                        }} style={{ fontSize: 11, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer', marginTop: 7, flexShrink: 0 }}>✕</button>
                      </div>
                      <AiFieldSuggestion
                        fieldType="bullet"
                        currentValue={b}
                        context={{ ...jobContext, sectionTitle: `${exp.role || 'Role'} at ${exp.company || 'Company'}` }}
                        onApply={v => {
                          const n=[...experience]; n[i]={...n[i],bullets:n[i].bullets.map((x,xi)=>xi===bi?v:x)}; onChange(n)
                        }}
                      />
                    </div>
                  ))}
                  <button onClick={() => {
                    const n=[...experience]; n[i]={...n[i],bullets:[...n[i].bullets,'']}; onChange(n)
                  }} style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', marginTop: 2 }}>
                    + Add bullet
                  </button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                  <button onClick={() => { onChange(experience.filter((_,xi)=>xi!==i)); setEditIdx(null) }}
                    style={{ fontSize: 10, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                  <Btn small variant="primary" onClick={() => setEditIdx(null)}>Done</Btn>
                </div>
              </div>
            ) : (
              <div key={i}
                draggable
                onDragStart={() => { dragIdx.current = i }}
                onDragOver={e => { e.preventDefault(); setDragOver(i) }}
                onDragLeave={() => setDragOver(null)}
                onDrop={() => handleDrop(i)}
                style={{ cursor: 'pointer', padding: '4px 4px 4px 0', borderRadius: 4, marginBottom: 12,
                  border: dragOver===i ? '0.5px dashed #185FA5' : '0.5px solid transparent',
                  background: dragOver===i ? 'rgba(24,95,165,0.03)' : 'transparent',
                  display: 'flex', alignItems: 'flex-start', gap: 4 }}
                onMouseEnter={e => { if(dragOver!==i)(e.currentTarget as HTMLDivElement).style.background='var(--bg-secondary)' }}
                onMouseLeave={e => { if(dragOver!==i)(e.currentTarget as HTMLDivElement).style.background='transparent' }}>
                <span title="Drag to reorder" style={{ fontSize: 13, color: 'var(--border)', cursor: 'grab', marginTop: 2, flexShrink: 0, userSelect: 'none' }}>⠿</span>
                <div style={{ flex: 1 }} onClick={() => setEditIdx(i)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <div>
                      <span style={{ fontSize: 12, fontWeight: 500 }}>{exp.role || <em style={{ color: 'var(--text-muted)' }}>Untitled</em>}</span>
                      {exp.company && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}> · {exp.company}</span>}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{exp.period}</span>
                  </div>
                  <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    {exp.bullets.filter(Boolean).map((b, j) => (
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
