import React from 'react'

export function Metric({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 9px', background: 'var(--bg)' }}>
      <div style={{ fontSize: 16, lineHeight: 1, fontWeight: 750, color: alert ? '#d97706' : 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4 }}>{label}</div>
    </div>
  )
}

export function EmptyText({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'error'; title?: string }) {
  return (
    <div title={title} style={{ padding: 12, fontSize: 11, color: tone === 'error' ? 'var(--c-danger)' : 'var(--text-muted)', lineHeight: 1.5 }}>
      {children}
    </div>
  )
}
