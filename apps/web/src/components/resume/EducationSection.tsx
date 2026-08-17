'use client'

import { useState, useRef } from 'react'
import { Btn } from '@/components/ui'
import type { ResumeContent } from '@/lib/types'
import { InlineInput } from './InlineInput'
import { SectionHeader, type DragHandleProps } from './SectionHeader'
import { useI18n } from '@/lib/i18n'

export function EducationSection({ education, onChange, dragHandleProps, onRemove }: {
  education:        ResumeContent['education']
  onChange:         (ed: ResumeContent['education']) => void
  dragHandleProps?: DragHandleProps
  onRemove?:        () => void
}) {
  const { t } = useI18n()
  const [editIdx,   setEditIdx]   = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [dragOver,  setDragOver]  = useState<number | null>(null)
  const dragIdx = useRef<number | null>(null)

  function handleDrop(i: number) {
    const from = dragIdx.current
    if (from === null || from === i) { setDragOver(null); return }
    const next = [...education]; const [item] = next.splice(from, 1); next.splice(i, 0, item)
    onChange(next); dragIdx.current = null; setDragOver(null)
    if (editIdx !== null) setEditIdx(null)
  }

  function addEdu() {
    const next = [...education, { institution: '', degree: '', year: '' }]
    onChange(next); setEditIdx(next.length - 1)
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <SectionHeader
        title={t('resume.section.education')}
        count={education.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(v => !v)}
        onAdd={addEdu}
        onRemove={onRemove}
        dragHandleProps={dragHandleProps}
      />

      {!collapsed && (
        <>
          {education.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 4px' }}>{t('resume.noEducation')}</div>
          )}

          {education.map((e, i) => (
            editIdx === i ? (
              <div key={i} style={{ border: '0.5px solid var(--primary)', borderRadius: 6, padding: 10, marginBottom: 8 }}>
                <InlineInput value={e.degree}      onChange={v => { const n=[...education]; n[i]={...n[i],degree:v};      onChange(n) }} placeholder={t('resume.degreePlaceholder')} style={{ marginBottom: 6 }} />
                <InlineInput value={e.institution} onChange={v => { const n=[...education]; n[i]={...n[i],institution:v}; onChange(n) }} placeholder={t('resume.institution')} style={{ marginBottom: 6 }} />
                <InlineInput value={e.year}        onChange={v => { const n=[...education]; n[i]={...n[i],year:v};        onChange(n) }} placeholder={t('resume.yearPlaceholder')} />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                  <button onClick={() => { onChange(education.filter((_,xi)=>xi!==i)); setEditIdx(null) }}
                    style={{ fontSize: 10, color: 'var(--c-danger)', background: 'none', border: 'none', cursor: 'pointer' }}>{t('common.delete')}</button>
                  <Btn small variant="primary" onClick={() => setEditIdx(null)}>{t('common.done')}</Btn>
                </div>
              </div>
            ) : (
              <div key={i}
                draggable
                onDragStart={() => { dragIdx.current = i }}
                onDragOver={e => { e.preventDefault(); setDragOver(i) }}
                onDragLeave={() => setDragOver(null)}
                onDrop={() => handleDrop(i)}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 4, cursor: 'pointer', padding: '4px 4px 4px 0', borderRadius: 4, marginBottom: 4,
                  border: dragOver===i ? '0.5px dashed var(--primary)' : '0.5px solid transparent',
                  background: dragOver===i ? 'rgba(24,95,165,0.03)' : 'transparent' }}
                onMouseEnter={e => { if(dragOver!==i)(e.currentTarget as HTMLDivElement).style.background='var(--bg-secondary)' }}
                onMouseLeave={e => { if(dragOver!==i)(e.currentTarget as HTMLDivElement).style.background='transparent' }}>
                <span title={t('resume.dragToReorder')} style={{ fontSize: 13, color: 'var(--border)', cursor: 'grab', marginTop: 2, flexShrink: 0, userSelect: 'none' }}>⠿</span>
                <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between' }} onClick={() => setEditIdx(i)}>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>{e.degree || <em style={{ color: 'var(--text-muted)' }}>{t('resume.degree')}</em>}</span>
                    {e.institution && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}> · {e.institution}</span>}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{e.year}</span>
                </div>
              </div>
            )
          ))}
        </>
      )}
    </div>
  )
}
