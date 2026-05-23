import React from 'react'

export function TopBar({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{
      minHeight: 52, flexShrink: 0,
      background: 'var(--glass-topbar)',
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      borderBottom: '1px solid var(--border-glass)',
      display: 'flex', alignItems: 'center', flexWrap: 'wrap',
      padding: '6px 20px', gap: 10,
      position: 'sticky', top: 0, zIndex: 20,
      boxShadow: '0 1px 0 var(--border), 0 2px 12px rgba(79,70,229,0.04)',
    }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', flex: 1, minWidth: 80, letterSpacing: '-0.01em' }}>{title}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  )
}
