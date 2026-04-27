import React from 'react'

export function TopBar({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{
      height: 48, flexShrink: 0, background: 'var(--bg)',
      borderBottom: '0.5px solid var(--border)',
      display: 'flex', alignItems: 'center', padding: '0 20px', gap: 12,
      position: 'sticky', top: 0, zIndex: 10,
    }}>
      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)', flex: 1 }}>{title}</span>
      {children}
    </div>
  )
}
