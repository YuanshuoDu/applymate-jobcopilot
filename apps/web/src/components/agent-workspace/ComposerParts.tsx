'use client'

import React from 'react'

export function ComposerMenuSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '3px 0 6px' }}>
      <div style={{ padding: '4px 7px', fontSize: 9, textTransform: 'uppercase', letterSpacing: 0, color: 'var(--text-muted)', fontWeight: 750 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {children}
      </div>
    </div>
  )
}

export function ComposerMenuButton({ label, meta, onClick }: {
  label: string
  meta: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        padding: '7px 8px',
        border: 'none',
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--text)',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</div>
    </button>
  )
}

export function ComposerMenuEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '7px 8px', fontSize: 10, color: 'var(--text-muted)' }}>
      {children}
    </div>
  )
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
