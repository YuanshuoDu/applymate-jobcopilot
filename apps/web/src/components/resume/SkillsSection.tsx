'use client'

import { useState } from 'react'

export function SkillsSection({ skills, matchedKeywords, onChange }: {
  skills:          string[]
  matchedKeywords: string[]
  onChange:        (s: string[]) => void
}) {
  const [adding,   setAdding]   = useState(false)
  const [newSkill, setNewSkill] = useState('')

  function commit() {
    const trimmed = newSkill.trim()
    if (trimmed && !skills.includes(trimmed)) onChange([...skills, trimmed])
    setNewSkill(''); setAdding(false)
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text)', borderBottom: '0.5px solid var(--border)', paddingBottom: 4, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>SKILLS</span>
        <button onClick={() => setAdding(true)} style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {skills.map(s => {
          const isMatch = matchedKeywords.some(k => s.toLowerCase().includes(k.toLowerCase()))
          return (
            <span key={s} style={{ fontSize: 11, background: isMatch ? 'rgba(59,109,17,0.1)' : 'var(--bg-secondary)', color: isMatch ? '#3B6D11' : 'var(--text)', border: `0.5px solid ${isMatch ? 'rgba(59,109,17,0.2)' : 'var(--border)'}`, borderRadius: 5, padding: '3px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
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
    </div>
  )
}
