'use client'

import { useState } from 'react'

export type AiFieldContext = {
  sectionTitle?:   string
  jobTitle?:       string
  jobCompany?:     string
  jobDescription?: string
}

export function AiFieldSuggestion({ fieldType, currentValue, context, onApply }: {
  fieldType:    'summary' | 'bullet' | 'description' | 'custom'
  currentValue: string
  context?:     AiFieldContext
  onApply:      (value: string) => void
}) {
  const [open,         setOpen]         = useState(false)
  const [loading,      setLoading]      = useState(false)
  const [suggestions,  setSuggestions]  = useState<string[]>([])
  const [editValues,   setEditValues]   = useState<string[]>([])
  const [feedbacks,    setFeedbacks]    = useState(['', '', ''])
  const [showFeedback, setShowFeedback] = useState([false, false, false])
  const [regen,        setRegen]        = useState([false, false, false])

  async function fetchSuggestions(fb?: { index: number; text: string }) {
    if (fb !== undefined) {
      setRegen(prev => { const n = [...prev]; n[fb.index] = true; return n })
    } else {
      setLoading(true)
    }
    try {
      const res = await fetch('/api/ai/field-suggest', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          fieldType,
          currentValue,
          context: {
            ...(context?.sectionTitle   && { role:            context.sectionTitle }),
            ...(context?.jobTitle       && { targetJob:       context.jobTitle }),
            ...(context?.jobCompany     && { targetCompany:   context.jobCompany }),
            ...(context?.jobDescription && { jobDescription:  context.jobDescription.slice(0, 600) }),
          },
          feedback: fb?.text,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'API error')
      const list: string[] = data.suggestions ?? []

      if (fb !== undefined) {
        setSuggestions(prev => { const n = [...prev]; n[fb.index] = list[0] ?? prev[fb.index]; return n })
        setEditValues(prev  => { const n = [...prev]; n[fb.index] = list[0] ?? prev[fb.index]; return n })
        setShowFeedback(prev => { const n = [...prev]; n[fb.index] = false; return n })
        setFeedbacks(prev   => { const n = [...prev]; n[fb.index] = '';    return n })
      } else {
        setSuggestions(list)
        setEditValues(list)
        setFeedbacks(['', '', ''])
        setShowFeedback([false, false, false])
      }
    } catch (e) {
      console.error('[AiFieldSuggestion]', e)
    } finally {
      setLoading(false)
      setRegen([false, false, false])
    }
  }

  function handleOpen() {
    setOpen(true)
    if (suggestions.length === 0) fetchSuggestions()
  }

  function handleApply(i: number) {
    onApply(editValues[i] ?? suggestions[i])
    setOpen(false)
  }

  if (!open) {
    return (
      <button onClick={handleOpen} title="Get AI suggestions"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          fontSize: 10, color: '#185FA5',
          background: 'rgba(24,95,165,0.07)', border: '0.5px solid rgba(24,95,165,0.2)',
          borderRadius: 10, padding: '2px 8px', cursor: 'pointer', marginTop: 4,
        }}>
        ✦ AI suggest
      </button>
    )
  }

  return (
    <div style={{
      marginTop: 8, border: '0.5px solid rgba(24,95,165,0.25)',
      borderRadius: 8, overflow: 'hidden',
      background: 'var(--bg)', boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
    }}>
      {/* Panel header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '7px 10px', background: 'rgba(24,95,165,0.06)',
        borderBottom: '0.5px solid rgba(24,95,165,0.15)',
      }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: '#185FA5' }}>✦ AI Suggestions</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => fetchSuggestions()} disabled={loading}
            title="Refresh all suggestions"
            style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            {loading ? '…' : '↻ Refresh'}
          </button>
          <button onClick={() => setOpen(false)}
            style={{ fontSize: 12, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}>
            ✕
          </button>
        </div>
      </div>

      {/* Suggestions */}
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 4px', color: 'var(--text-muted)', fontSize: 11 }}>
            <div style={{ width: 14, height: 14, border: '2px solid rgba(24,95,165,0.3)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
            Generating 3 suggestions…
          </div>
        ) : suggestions.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '8px 4px' }}>No suggestions yet.</div>
        ) : suggestions.map((s, i) => (
          <div key={i} style={{
            border: '0.5px solid var(--border)', borderRadius: 6,
            overflow: 'hidden', background: 'var(--bg-secondary)',
          }}>
            {/* Option number bar */}
            <div style={{ padding: '4px 8px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-muted)' }}>OPTION {i + 1}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => handleApply(i)}
                  style={{ fontSize: 10, color: '#3B6D11', fontWeight: 600, background: 'rgba(59,109,17,0.08)', border: '0.5px solid rgba(59,109,17,0.2)', borderRadius: 4, padding: '1px 8px', cursor: 'pointer' }}>
                  Apply
                </button>
                <button onClick={() => setShowFeedback(prev => { const n = [...prev]; n[i] = !n[i]; return n })}
                  style={{ fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  {showFeedback[i] ? 'Cancel' : 'Revise'}
                </button>
              </div>
            </div>

            {/* Editable suggestion text */}
            <textarea
              value={editValues[i] ?? s}
              onChange={e => setEditValues(prev => { const n = [...prev]; n[i] = e.target.value; return n })}
              rows={fieldType === 'summary' ? 4 : 2}
              style={{
                width: '100%', fontSize: 12, lineHeight: 1.6, padding: '8px 10px',
                border: 'none', outline: 'none', resize: 'vertical',
                background: 'var(--bg-secondary)', color: 'var(--text)',
                boxSizing: 'border-box', display: 'block',
              }}
            />

            {/* Revise / feedback row */}
            {showFeedback[i] && (
              <div style={{ padding: '6px 8px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  autoFocus
                  value={feedbacks[i]}
                  onChange={e => setFeedbacks(prev => { const n = [...prev]; n[i] = e.target.value; return n })}
                  onKeyDown={e => { if (e.key === 'Enter' && feedbacks[i].trim()) fetchSuggestions({ index: i, text: feedbacks[i] }) }}
                  placeholder="e.g. make it more quantifiable, add leadership…"
                  style={{
                    flex: 1, fontSize: 11, padding: '4px 8px',
                    border: '0.5px solid var(--border)', borderRadius: 5,
                    outline: 'none', color: 'var(--text)', background: 'var(--bg)',
                  }}
                />
                <button
                  onClick={() => feedbacks[i].trim() && fetchSuggestions({ index: i, text: feedbacks[i] })}
                  disabled={regen[i] || !feedbacks[i].trim()}
                  style={{
                    fontSize: 10, color: '#185FA5', fontWeight: 500,
                    background: 'rgba(24,95,165,0.08)', border: '0.5px solid rgba(24,95,165,0.2)',
                    borderRadius: 4, padding: '3px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
                  }}>
                  {regen[i] ? '…' : '↻ Regen'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
