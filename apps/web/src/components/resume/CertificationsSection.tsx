'use client'

import { useState, useRef } from 'react'
import { Btn } from '@/components/ui'
import type { ResumeContent } from '@/lib/types'
import { InlineInput } from './InlineInput'
import { SectionHeader, type DragHandleProps } from './SectionHeader'

type Cert = NonNullable<ResumeContent['certifications']>[number]

export function CertificationsSection({ certifications, onChange, dragHandleProps, onRemove }: {
  certifications:   Cert[]
  onChange:         (c: Cert[]) => void
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
    const next = [...certifications]; const [item] = next.splice(from, 1); next.splice(i, 0, item)
    onChange(next); dragIdx.current = null; setDragOver(null)
  }

  function addCert() {
    const next = [...certifications, { name: '', issuer: '', date: '' }]
    onChange(next); setEditIdx(next.length - 1)
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <SectionHeader
        title="CERTIFICATIONS"
        count={certifications.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(v => !v)}
        onAdd={addCert}
        onRemove={onRemove}
        dragHandleProps={dragHandleProps}
      />

      {!collapsed && (
        <>
          {certifications.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 4px' }}>No certifications added yet.</div>
          )}

          {certifications.map((c, i) => (
            editIdx === i ? (
              <div key={i} style={{ border: '0.5px solid var(--primary)', borderRadius: 6, padding: 10, marginBottom: 8 }}>
                <InlineInput value={c.name}   onChange={v => { const n=[...certifications]; n[i]={...n[i],name:v};   onChange(n) }} placeholder="Certification Name" style={{ marginBottom: 6 }} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                  <InlineInput value={c.issuer} onChange={v => { const n=[...certifications]; n[i]={...n[i],issuer:v}; onChange(n) }} placeholder="Issuing Organization" />
                  <InlineInput value={c.date}   onChange={v => { const n=[...certifications]; n[i]={...n[i],date:v};   onChange(n) }} placeholder="Date (e.g. Mar 2024)" />
                </div>
                <InlineInput value={c.url??''} onChange={v => { const n=[...certifications]; n[i]={...n[i],url:v||undefined}; onChange(n) }} placeholder="Credential URL (optional)" />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                  <button onClick={() => { onChange(certifications.filter((_,xi)=>xi!==i)); setEditIdx(null) }}
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
                style={{ display: 'flex', gap: 4, cursor: 'pointer', padding: '4px 4px 4px 0', borderRadius: 4, marginBottom: 6,
                  border: dragOver===i ? '0.5px dashed var(--primary)' : '0.5px solid transparent',
                  background: dragOver===i ? 'rgba(24,95,165,0.03)' : 'transparent' }}
                onMouseEnter={e => { if(dragOver!==i)(e.currentTarget as HTMLDivElement).style.background='var(--bg-secondary)' }}
                onMouseLeave={e => { if(dragOver!==i)(e.currentTarget as HTMLDivElement).style.background='transparent' }}>
                <span style={{ fontSize: 13, color: 'var(--border)', cursor: 'grab', marginTop: 2, flexShrink: 0, userSelect: 'none' }}>⠿</span>
                <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }} onClick={() => setEditIdx(i)}>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>{c.name || <em style={{ color: 'var(--text-muted)' }}>Untitled</em>}</span>
                    {c.issuer && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}> · {c.issuer}</span>}
                    {c.url && <a href={c.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: 10, color: 'var(--primary)', marginLeft: 8 }}>↗ verify</a>}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{c.date}</span>
                </div>
              </div>
            )
          ))}
        </>
      )}
    </div>
  )
}
