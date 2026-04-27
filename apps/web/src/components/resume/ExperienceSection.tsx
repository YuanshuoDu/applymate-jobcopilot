'use client'

import { useState } from 'react'
import { Btn } from '@/components/ui'
import type { ResumeContent } from '@/lib/types'
import { InlineInput } from './InlineInput'

export function ExperienceSection({ experience, onChange }: {
  experience: ResumeContent['experience']
  onChange:   (exp: ResumeContent['experience']) => void
}) {
  const [editIdx, setEditIdx] = useState<number | null>(null)

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text)', borderBottom: '0.5px solid var(--border)', paddingBottom: 4, marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>EXPERIENCE</span>
        <button onClick={() => {
          const next = [...experience, { company: '', role: '', period: '', bullets: [''] }]
          onChange(next)
          setEditIdx(next.length - 1)
        }} style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add</button>
      </div>

      {experience.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 4px' }}>No experience added yet.</div>
      )}

      {experience.map((exp, i) => (
        editIdx === i ? (
          <div key={i} style={{ border: '0.5px solid #185FA5', borderRadius: 6, padding: 10, marginBottom: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
              <InlineInput value={exp.role}    onChange={v => { const n = [...experience]; n[i] = { ...n[i], role: v };    onChange(n) }} placeholder="Job Title" />
              <InlineInput value={exp.company} onChange={v => { const n = [...experience]; n[i] = { ...n[i], company: v }; onChange(n) }} placeholder="Company" />
            </div>
            <InlineInput value={exp.period} onChange={v => { const n = [...experience]; n[i] = { ...n[i], period: v }; onChange(n) }} placeholder="e.g. Jan 2022 – Present" style={{ marginBottom: 8 }} />
            <div>
              {exp.bullets.map((b, bi) => (
                <div key={bi} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 7, flexShrink: 0 }}>•</span>
                  <InlineInput value={b} onChange={v => {
                    const n = [...experience]; n[i] = { ...n[i], bullets: n[i].bullets.map((x, xi) => xi === bi ? v : x) }; onChange(n)
                  }} multiline placeholder="Describe your accomplishment…" style={{ minHeight: 36 }} />
                  <button onClick={() => {
                    const n = [...experience]; n[i] = { ...n[i], bullets: n[i].bullets.filter((_, xi) => xi !== bi) }; onChange(n)
                  }} style={{ fontSize: 11, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer', marginTop: 7, flexShrink: 0 }}>✕</button>
                </div>
              ))}
              <button onClick={() => {
                const n = [...experience]; n[i] = { ...n[i], bullets: [...n[i].bullets, ''] }; onChange(n)
              }} style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', marginTop: 2 }}>+ Add bullet</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <button onClick={() => { onChange(experience.filter((_, xi) => xi !== i)); setEditIdx(null) }}
                style={{ fontSize: 10, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
              <Btn small variant="primary" onClick={() => setEditIdx(null)}>Done</Btn>
            </div>
          </div>
        ) : (
          <div key={i} onClick={() => setEditIdx(i)} style={{ cursor: 'pointer', padding: 4, borderRadius: 4, marginBottom: 12 }}
            onMouseEnter={e => ((e.currentTarget as HTMLDivElement).style.background = 'var(--bg-secondary)')}
            onMouseLeave={e => ((e.currentTarget as HTMLDivElement).style.background = 'transparent')}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <div>
                <span style={{ fontSize: 12, fontWeight: 500 }}>{exp.role || <em style={{ color: 'var(--text-muted)' }}>Untitled</em>}</span>
                {exp.company && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}> · {exp.company}</span>}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{exp.period}</span>
            </div>
            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
              {exp.bullets.filter(Boolean).map((b, j) => (
                <li key={j} style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text)' }}>{b}</li>
              ))}
            </ul>
          </div>
        )
      ))}
    </div>
  )
}
