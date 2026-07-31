import React from 'react'

export function TopBar({ title, titleAccessory, children }: { title: string; titleAccessory?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div style={{
      minHeight: 62, flexShrink: 0,
      background: 'var(--glass-topbar)',
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      borderBottom: '1px solid var(--border-glass)',
      display: 'flex', alignItems: 'center', flexWrap: 'wrap',
      padding: '8px 112px 8px 20px', gap: 10,
      position: 'sticky', top: 0, zIndex: 20,
      boxShadow: '0 1px 0 var(--border), 0 2px 12px rgba(79,70,229,0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 80 }}>
        <span style={{ fontSize: 22, fontWeight: 760, lineHeight: 1.1, color: 'var(--text)', letterSpacing: '-0.05em', whiteSpace: 'nowrap' }}>{title}</span>
        {titleAccessory}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  )
}
