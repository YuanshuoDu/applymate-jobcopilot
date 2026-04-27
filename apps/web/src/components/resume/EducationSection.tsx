'use client'

import { useState } from 'react'
import { Btn } from '@/components/ui'
import type { ResumeContent } from '@/lib/types'
import { InlineInput } from './InlineInput'

export function EducationSection({ education, onChange }: {
  education: ResumeContent['education']
  onChange:  (ed: ResumeContent['education']) => void
}) {
  const [editIdx, setEditIdx] = useState<number | null>(null)

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text)', borderBottom: '0.5px solid var(--border)', paddingBottom: 4, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>EDUCATION</span>
        <button onClick={() => {
          const next = [...education, { institution: '', degree: '', year: '' }]
          onChange(next)
          setEditIdx(next.length - 1)
        }} style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add</button>
      </div>

      {education.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 4px' }}>No education added yet.</div>
      )}

      {education.map((e, i) => (
        editIdx === i ? (
          <div key={i} style={{ border: '0.5px solid #185FA5', borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <InlineInput value={e.degree}      onChange={v => { const n = [...education]; n[i] = { ...n[i], degree: v };      onChange(n) }} placeholder="Degree (e.g. BSc Computer Science)" style={{ marginBottom: 6 }} />
            <InlineInput value={e.institution} onChange={v => { const n = [...education]; n[i] = { ...n[i], institution: v }; onChange(n) }} placeholder="Institution" style={{ marginBottom: 6 }} />
            <InlineInput value={e.year}        onChange={v => { const n = [...education]; n[i] = { ...n[i], year: v };        onChange(n) }} placeholder="Year (e.g. 2020)" />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <button onClick={() => { onChange(education.filter((_, xi) => xi !== i)); setEditIdx(null) }}
                style={{ fontSize: 10, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
              <Btn small variant="primary" onClick={() => setEditIdx(null)}>Done</Btn>
            </div>
          </div>
        ) : (
          <div key={i} onClick={() => setEditIdx(i)} style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer', padding: 4, borderRadius: 4, marginBottom: 4 }}
            onMouseEnter={evt => ((evt.currentTarget as HTMLDivElement).style.background = 'var(--bg-secondary)')}
            onMouseLeave={evt => ((evt.currentTarget as HTMLDivElement).style.background = 'transparent')}>
            <div>
              <span style={{ fontSize: 12, fontWeight: 500 }}>{e.degree || <em style={{ color: 'var(--text-muted)' }}>Degree</em>}</span>
              {e.institution && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}> · {e.institution}</span>}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{e.year}</span>
          </div>
        )
      ))}
    </div>
  )
}
