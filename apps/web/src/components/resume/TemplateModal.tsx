'use client'

import { Btn, Card } from '@/components/ui'

const TEMPLATES = [
  { id: 'minimal', name: 'Minimal', desc: 'Clean single-column' },
  { id: 'modern',  name: 'Modern',  desc: 'Two-column with accent' },
  { id: 'compact', name: 'Compact', desc: 'Dense, ATS-friendly' },
]

export function TemplateModal({ current, onSelect, onClose }: {
  current:  string
  onSelect: (id: string) => void
  onClose:  () => void
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <Card style={{ width: 480, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>Choose Template</span>
          <Btn small variant="ghost" onClick={onClose}>✕</Btn>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
          {TEMPLATES.map(t => (
            <div key={t.id} onClick={() => { onSelect(t.id); onClose() }} style={{
              border: current === t.id ? '2px solid #185FA5' : '0.5px solid var(--border)',
              borderRadius: 8, padding: 12, cursor: 'pointer',
              background: current === t.id ? 'rgba(24,95,165,0.05)' : 'var(--bg)',
            }}>
              <div style={{ height: 80, background: 'var(--bg-tertiary)', borderRadius: 6, marginBottom: 8 }} />
              <div style={{ fontSize: 12, fontWeight: 500 }}>{t.name}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t.desc}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

export { TEMPLATES }
