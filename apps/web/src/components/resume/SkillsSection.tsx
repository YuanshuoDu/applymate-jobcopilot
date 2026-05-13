'use client'

import { useState } from 'react'
import { SectionHeader, type DragHandleProps } from './SectionHeader'

export function SkillsSection({ skills, matchedKeywords, onChange, dragHandleProps, onRemove, flash }: {
  skills:           string[]
  matchedKeywords:  string[]
  onChange:         (s: string[]) => void
  dragHandleProps?: DragHandleProps
  onRemove?:        () => void
  flash?:           boolean
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [adding,    setAdding]    = useState(false)
  const [newSkill,  setNewSkill]  = useState('')

  function commit() {
    const trimmed = newSkill.trim()
    if (trimmed && !skills.includes(trimmed)) onChange([...skills, trimmed])
    setNewSkill(''); setAdding(false)
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <SectionHeader
        title="SKILLS"
        count={skills.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(v => !v)}
        onAdd={() => setAdding(true)}
        onRemove={onRemove}
        dragHandleProps={dragHandleProps}
      />

      {!collapsed && (
        <div className={flash ? 'ai-flash-highlight' : ''} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {skills.map((s, i) => {
            const isMatch = matchedKeywords.some(k => s.toLowerCase().includes(k.toLowerCase()))
            return (
              <span key={`${s}-${i}`} style={{ fontSize: 11, background: isMatch ? 'rgba(59,109,17,0.1)' : 'var(--bg-secondary)', color: isMatch ? '#3B6D11' : 'var(--text)', border: `0.5px solid ${isMatch ? 'rgba(59,109,17,0.2)' : 'var(--border)'}`, borderRadius: 5, padding: '3px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
                {isMatch && <span style={{ fontSize: 8, color: '#3B6D11' }}>✓</span>}
                {s}
                <button onClick={() => onChange(skills.filter(x => x !== s))} style={{ fontSize: 9, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1, padding: 0 }}>✕</button>
              </span>
            )
          })}
          {adding && (
            <input value={newSkill} autoFocus
              onChange={e => setNewSkill(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setAdding(false) }}
              onBlur={commit}
              placeholder="Skill…"
              style={{ fontSize: 11, border: '0.5px solid #185FA5', borderRadius: 5, padding: '3px 8px', outline: 'none', width: 100, color: 'var(--text)', background: 'var(--bg)' }} />
          )}
          {skills.length === 0 && !adding && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No skills added — click + Add</span>
          )}
        </div>
      )}
    </div>
  )
}
