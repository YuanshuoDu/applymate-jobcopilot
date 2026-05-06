'use client'

import { useState } from 'react'
import type { ResumeContent } from '@/lib/types'
import { SectionHeader, type DragHandleProps } from './SectionHeader'

type LangEntry = NonNullable<ResumeContent['languages']>[number]

const LEVELS     = ['Native', 'Fluent', 'Advanced', 'Intermediate', 'Basic']
const LEVEL_DOTS: Record<string, number> = { Native: 5, Fluent: 4, Advanced: 3, Intermediate: 2, Basic: 1 }
const LEVEL_COLOR: Record<string, string> = {
  Native: '#185FA5', Fluent: '#185FA5', Advanced: '#3B6D11', Intermediate: '#854F0B', Basic: '#A32D2D',
}

export function LanguagesSection({ languages, onChange, dragHandleProps, onRemove }: {
  languages:        LangEntry[]
  onChange:         (langs: LangEntry[]) => void
  dragHandleProps?: DragHandleProps
  onRemove?:        () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [adding,    setAdding]    = useState(false)
  const [newLang,   setNewLang]   = useState('')
  const [newLevel,  setNewLevel]  = useState('Fluent')
  const [editIdx,   setEditIdx]   = useState<number | null>(null)

  function commit() {
    const trimmed = newLang.trim()
    if (trimmed && !languages.some(l => l.lang.toLowerCase() === trimmed.toLowerCase())) {
      onChange([...languages, { lang: trimmed, level: newLevel }])
    }
    setNewLang(''); setAdding(false)
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <SectionHeader
        title="LANGUAGES"
        count={languages.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(v => !v)}
        onAdd={() => setAdding(true)}
        onRemove={onRemove}
        dragHandleProps={dragHandleProps}
      />

      {!collapsed && (
        <>
          {languages.length === 0 && !adding && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>No languages added — click + Add</div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {languages.map((l, i) => (
              editIdx === i ? (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', border: '0.5px solid #185FA5', borderRadius: 6, background: 'var(--bg)' }}>
                  <input autoFocus value={l.lang}
                    onChange={e => { const n=[...languages]; n[i]={...n[i],lang:e.target.value}; onChange(n) }}
                    onKeyDown={e => { if (e.key==='Enter'||e.key==='Escape') setEditIdx(null) }}
                    style={{ fontSize: 12, border: 'none', outline: 'none', width: 90, background: 'transparent', color: 'var(--text)', fontWeight: 500 }}
                  />
                  <select value={l.level} onChange={e => { const n=[...languages]; n[i]={...n[i],level:e.target.value}; onChange(n) }}
                    style={{ fontSize: 10, border: '0.5px solid var(--border)', borderRadius: 4, padding: '2px 4px', background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
                    {LEVELS.map(lv => <option key={lv}>{lv}</option>)}
                  </select>
                  <button onClick={() => setEditIdx(null)} style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>Done</button>
                  <button onClick={() => { onChange(languages.filter((_,xi)=>xi!==i)); setEditIdx(null) }}
                    style={{ fontSize: 10, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer' }}>Del</button>
                </div>
              ) : (
                <div key={i} onClick={() => setEditIdx(i)} title="Click to edit"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: 'var(--bg-secondary)', borderRadius: 6, border: '0.5px solid var(--border)', cursor: 'pointer' }}
                  onMouseEnter={e => ((e.currentTarget as HTMLDivElement).style.borderColor = '#185FA5')}
                  onMouseLeave={e => ((e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)')}>
                  <span style={{ fontSize: 12, fontWeight: 500 }}>{l.lang}</span>
                  <span style={{ fontSize: 9, color: LEVEL_COLOR[l.level] ?? 'var(--text-muted)', fontWeight: 500 }}>{l.level}</span>
                  <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    {Array.from({ length: 5 }).map((_, d) => (
                      <div key={d} style={{ width: 5, height: 5, borderRadius: '50%', background: d < (LEVEL_DOTS[l.level] ?? 0) ? (LEVEL_COLOR[l.level] ?? '#185FA5') : 'var(--border)' }} />
                    ))}
                  </div>
                </div>
              )
            ))}

            {adding && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', border: '0.5px solid #185FA5', borderRadius: 6, background: 'var(--bg)' }}>
                <input autoFocus value={newLang}
                  onChange={e => setNewLang(e.target.value)}
                  onKeyDown={e => { if (e.key==='Enter') commit(); if (e.key==='Escape') setAdding(false) }}
                  placeholder="Language…"
                  style={{ fontSize: 12, border: 'none', outline: 'none', width: 90, background: 'transparent', color: 'var(--text)', fontWeight: 500 }}
                />
                <select value={newLevel} onChange={e => setNewLevel(e.target.value)}
                  style={{ fontSize: 10, border: '0.5px solid var(--border)', borderRadius: 4, padding: '2px 4px', background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
                  {LEVELS.map(l => <option key={l}>{l}</option>)}
                </select>
                <button onClick={commit} style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>Add</button>
                <button onClick={() => setAdding(false)} style={{ fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
