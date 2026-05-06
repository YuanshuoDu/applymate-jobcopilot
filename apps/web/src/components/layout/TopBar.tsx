import React from 'react'

export function TopBar({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{
      minHeight: 48, flexShrink: 0, background: 'var(--bg)',
      borderBottom: '0.5px solid var(--border)',
      display: 'flex', alignItems: 'center', flexWrap: 'wrap',
      padding: '6px 16px', gap: 8,
      position: 'sticky', top: 0, zIndex: 10,
    }}>
      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)', flex: 1, minWidth: 80 }}>{title}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  )
}
