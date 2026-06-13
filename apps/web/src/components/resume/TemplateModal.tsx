'use client'

import { useState } from 'react'
import { Btn } from '@/components/ui'
import { ResumeRenderer, TEMPLATE_DEFS, ACCENT_COLORS, FONT_FAMILIES, DENSITY_SCALE } from './ResumeRenderer'
import type { ResumeContent, TemplateOptions } from '@/lib/types'

export const TEMPLATES = TEMPLATE_DEFS

// Sample content for thumbnails
const SAMPLE: ResumeContent = {
  contact:    { name: 'Alex Johnson', email: 'alex@email.com', location: 'London, UK', phone: '+44 7000 000000', linkedin: 'linkedin.com' },
  summary:    'Experienced product manager with 7+ years driving growth at tech companies.',
  experience: [
    { company: 'Acme Corp',  role: 'Senior PM',       period: '2021–present', bullets: ['Launched 3 products generating $2M ARR', 'Led team of 12 engineers'] },
    { company: 'StartupXYZ', role: 'Product Manager', period: '2018–2021',    bullets: ['Grew user base 3× to 500k DAU'] },
  ],
  skills:    ['Product Strategy', 'Roadmapping', 'SQL', 'Figma', 'Agile'],
  education: [{ degree: 'BSc Computer Science', institution: 'University of Manchester', year: '2018' }],
}

export function TemplateModal({ current, currentOptions, onSelect, onClose }: {
  current:         string
  currentOptions?: TemplateOptions | null
  onSelect:        (id: string, opts: TemplateOptions) => void
  onClose:         () => void
}) {
  const [activeId,   setActiveId]   = useState(current)
  const [accentHex,  setAccentHex]  = useState(currentOptions?.accentColor ?? ACCENT_COLORS[0].hex)
  const [fontId,     setFontId]     = useState<'serif' | 'sans' | 'mono'>(currentOptions?.fontFamily ?? 'sans')
  const [density,    setDensity]    = useState<TemplateOptions['density']>(currentOptions?.density ?? 'comfortable')

  function handleApply() {
    onSelect(activeId, { accentColor: accentHex, fontFamily: fontId as TemplateOptions['fontFamily'], density })
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 12, width: 780, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 16px 64px rgba(0,0,0,0.2)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '0.5px solid var(--border)', flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Choose Template</span>
          <Btn small variant="ghost" onClick={onClose}>✕</Btn>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Template grid */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
              {TEMPLATE_DEFS.map(t => (
                <div key={t.id} onClick={() => setActiveId(t.id)}
                  style={{ cursor: 'pointer', borderRadius: 8, overflow: 'hidden', border: activeId === t.id ? `2px solid ${accentHex}` : '1.5px solid var(--border)', transition: 'border-color 0.15s', background: 'var(--bg-secondary)' }}>
                  {/* Thumbnail */}
                  <div style={{ height: 160, overflow: 'hidden', position: 'relative', background: '#f8f8f8' }}>
                    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
                      <ResumeRenderer
                        content={SAMPLE}
                        templateId={t.id}
                        templateOptions={{ accentColor: accentHex, fontFamily: fontId as TemplateOptions['fontFamily'], density }}
                        scale={0.28}
                      />
                    </div>
                    {activeId === t.id && (
                      <div style={{ position: 'absolute', top: 6, right: 6, background: accentHex, color: '#fff', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>✓</div>
                    )}
                  </div>
                  {/* Label */}
                  <div style={{ padding: '8px 10px' }}>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{t.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Options sidebar */}
          <div style={{ width: 200, borderLeft: '0.5px solid var(--border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 20, overflowY: 'auto', flexShrink: 0 }}>

            {/* Accent color */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10 }}>ACCENT COLOR</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {ACCENT_COLORS.map(ac => (
                  <button key={ac.id} onClick={() => setAccentHex(ac.hex)} title={ac.label}
                    style={{ width: 26, height: 26, borderRadius: '50%', background: ac.hex, border: accentHex === ac.hex ? `3px solid var(--text)` : '2px solid transparent', cursor: 'pointer', transition: 'border 0.1s' }} />
                ))}
              </div>
            </div>

            {/* Font */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10 }}>FONT STYLE</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {FONT_FAMILIES.map(f => (
                  <button key={f.id} onClick={() => setFontId(f.id as 'serif' | 'sans' | 'mono')}
                    style={{ textAlign: 'left', padding: '6px 10px', borderRadius: 6, border: fontId === f.id ? `1.5px solid ${accentHex}` : '1.5px solid var(--border)', background: fontId === f.id ? `${accentHex}10` : 'var(--bg)', cursor: 'pointer', transition: 'all 0.1s' }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', fontFamily: f.css }}>{f.label}</div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{f.id}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Density */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10 }}>SPACING</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(Object.keys(DENSITY_SCALE) as Array<keyof typeof DENSITY_SCALE>).map(d => (
                  <button key={d} onClick={() => setDensity(d)}
                    style={{ textAlign: 'left', padding: '6px 10px', borderRadius: 6, border: density === d ? `1.5px solid ${accentHex}` : '1.5px solid var(--border)', background: density === d ? `${accentHex}10` : 'var(--bg)', cursor: 'pointer', transition: 'all 0.1s' }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', textTransform: 'capitalize' }}>{d}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '0.5px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 10, flexShrink: 0 }}>
          <Btn small variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn small variant="primary" onClick={handleApply}>Apply Template</Btn>
        </div>
      </div>
    </div>
  )
}
