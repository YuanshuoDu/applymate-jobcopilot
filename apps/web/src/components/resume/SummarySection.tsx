'use client'

export function SummarySection({ summary, matchedKeywords, editing, onEdit, onBlur, onChange }: {
  summary:         string
  matchedKeywords: string[]
  editing:         boolean
  onEdit:          () => void
  onBlur:          () => void
  onChange:        (s: string) => void
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text)', borderBottom: '0.5px solid var(--border)', paddingBottom: 4, marginBottom: 8 }}>SUMMARY</div>
      {editing ? (
        <textarea value={summary} onChange={e => onChange(e.target.value)}
          onBlur={onBlur} autoFocus placeholder="Write a brief professional summary…"
          style={{ width: '100%', minHeight: 80, fontSize: 12, lineHeight: 1.7, border: '0.5px solid #185FA5', borderRadius: 5, padding: 8, resize: 'vertical', outline: 'none', color: 'var(--text)', background: 'var(--bg)', boxSizing: 'border-box' }} />
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
      )}
    </div>
  )
}
