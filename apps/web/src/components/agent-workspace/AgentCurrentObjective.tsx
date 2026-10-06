'use client'

import React from 'react'

export function AgentCurrentObjective({ goal }: { goal?: string | null }) {
  if (typeof goal !== 'string' || !goal.trim()) return null

  return (
    <section
      aria-label="Current objective"
      data-agent-current-objective="true"
      style={{ flexShrink: 0, padding: '8px 18px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}
    >
      <div style={{ marginBottom: 4, color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>
        Current objective
      </div>
      <div style={{ maxHeight: 72, overflowY: 'auto', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', color: 'var(--text)', fontSize: 12, lineHeight: 1.45 }}>
        {goal}
      </div>
    </section>
  )
}
