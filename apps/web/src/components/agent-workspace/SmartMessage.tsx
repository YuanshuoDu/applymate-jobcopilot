'use client'

import React from 'react'

export function SmartMessage({ text, color }: { text: string; color?: string }) {
  const lines = text.split('\n').filter(l => l.trim())
  const listLines = lines.filter(l => /^[-•*·]\s/.test(l.trim()) || /^\d+\.\s/.test(l.trim()))
  const hasList = listLines.length >= 2

  const renderInline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code style="background:rgba(0,0,0,0.1);padding:1px 4px;border-radius:3px;font-size:10px">$1</code>')

  if (hasList) {
    const items: React.ReactNode[] = []
    for (const line of lines) {
      const isBullet = /^[-•*·]\s/.test(line.trim())
      const isNum = /^\d+\.\s/.test(line.trim())
      if (isBullet || isNum) {
        const content = line.trim().replace(/^[-•*·\d.]\s+/, '')
        items.push(
          <div key={items.length} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 2 }}>
            <span style={{ flexShrink: 0, color: 'inherit', opacity: 0.6, marginTop: 1 }}>{isNum ? `${items.length + 1}.` : '•'}</span>
            <span dangerouslySetInnerHTML={{ __html: renderInline(content) }} />
          </div>,
        )
      } else {
        items.push(
          <div key={items.length} style={{ marginBottom: 4, fontWeight: 500 }}
            dangerouslySetInnerHTML={{ __html: renderInline(line.trim()) }} />,
        )
      }
    }
    return <div style={{ fontSize: 11, color: color ?? 'var(--text)', lineHeight: 1.7, fontFamily: 'inherit' }}>{items}</div>
  }

  if (lines.length > 1) {
    return (
      <div style={{ fontSize: 11, color: color ?? 'var(--text)', lineHeight: 1.7, fontFamily: 'monospace' }}>
        {lines.map((line, index) => (
          <div key={index} dangerouslySetInnerHTML={{ __html: renderInline(line.trim()) }} />
        ))}
      </div>
    )
  }

  return (
    <span
      style={{ fontSize: 11, color: color ?? 'var(--text)', lineHeight: 1.6 }}
      dangerouslySetInnerHTML={{ __html: renderInline(text) }}
    />
  )
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char)
}
