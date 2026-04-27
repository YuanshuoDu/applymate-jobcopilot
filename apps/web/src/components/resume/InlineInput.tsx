'use client'

import React from 'react'

export function InlineInput({ value, onChange, style, placeholder, multiline }: {
  value:       string
  onChange:    (v: string) => void
  style?:      React.CSSProperties
  placeholder?: string
  multiline?:  boolean
}) {
  const base: React.CSSProperties = {
    width: '100%', fontSize: 12,
    border: '0.5px solid rgba(24,95,165,0.5)', borderRadius: 5,
    padding: '4px 7px', outline: 'none',
    color: 'var(--text)', background: 'var(--bg)', boxSizing: 'border-box',
    ...style,
  }
  return multiline
    ? <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ ...base, minHeight: 60, resize: 'vertical', lineHeight: 1.6 }} />
    : <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={base} />
}
