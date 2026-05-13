'use client'

import { useState } from 'react'
import { SectionHeader, type DragHandleProps } from './SectionHeader'
import { AiFieldSuggestion, type AiFieldContext } from './AiFieldSuggestion'

export function SummarySection({ summary, matchedKeywords, editing, onEdit, onBlur, onChange, jobContext, dragHandleProps, onRemove, flash }: {
  summary:          string
  matchedKeywords:  string[]
  editing:          boolean
  onEdit:           () => void
  onBlur:           () => void
  onChange:         (s: string) => void
  jobContext?:      AiFieldContext
  dragHandleProps?: DragHandleProps
  onRemove?:        () => void
  flash?:           boolean
}) {
  const [collapsed, setCollapsed] = useState(false)
  const wordCount   = summary.trim() ? summary.trim().split(/\s+/).filter(Boolean).length : 0
  const wColor      = wordCount === 0 ? 'var(--text-muted)' : wordCount < 20 ? '#A32D2D' : wordCount <= 80 ? '#3B6D11' : '#854F0B'

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 0 }}>
        <div style={{ flex: 1 }}>
          <SectionHeader
            title="SUMMARY"
            collapsed={collapsed}
            onToggle={() => setCollapsed(v => !v)}
            onRemove={onRemove}
            dragHandleProps={dragHandleProps}
          />
        </div>
        {!collapsed && wordCount > 0 && (
          <span style={{ fontSize: 9, color: wColor, fontWeight: 500, marginLeft: 8, marginTop: -4 }}>{wordCount}w</span>
        )}
      </div>

      {!collapsed && (
        editing ? (
          <div>
            <textarea value={summary} onChange={e => onChange(e.target.value)}
              onBlur={onBlur} autoFocus placeholder="Write a brief professional summary (20–80 words)…"
              className={flash ? 'ai-flash-highlight' : ''}
              style={{ width: '100%', minHeight: 80, fontSize: 12, lineHeight: 1.7, border: '0.5px solid #185FA5', borderRadius: 5, padding: 8, resize: 'vertical', outline: 'none', color: 'var(--text)', background: 'var(--bg)', boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
              <span style={{ fontSize: 9, color: wColor }}>
                {wordCount === 0 ? 'Start typing…' : wordCount < 20 ? `${wordCount} words — aim for 20+` : wordCount <= 80 ? `${wordCount} words — good length` : `${wordCount} words — consider trimming`}
              </span>
            </div>
            <AiFieldSuggestion
              fieldType="summary"
              currentValue={summary}
              context={jobContext}
              onApply={v => { onChange(v); onBlur() }}
            />
          </div>
        ) : (
          <div onClick={onEdit} style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text)', cursor: 'text', padding: 4, borderRadius: 4, minHeight: 32 }}
            onMouseEnter={e => ((e.currentTarget as HTMLDivElement).style.background = 'var(--bg-secondary)')}
            onMouseLeave={e => ((e.currentTarget as HTMLDivElement).style.background = 'transparent')}>
            {summary
              ? summary.split(' ').map((word, i) => {
                  const isKw = matchedKeywords.some(k => word.toLowerCase().includes(k.toLowerCase()))
                  return <span key={i} style={isKw ? { background: 'rgba(24,95,165,0.12)', borderRadius: 2, padding: '0 1px' } : {}}>{word} </span>
                })
              : <span style={{ color: 'var(--text-muted)' }}>Click to add a summary…</span>
            }
          </div>
        )
      )}
    </div>
  )
}
