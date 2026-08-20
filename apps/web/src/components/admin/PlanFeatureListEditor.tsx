'use client'

import { Plus, Trash2 } from 'lucide-react'
import React, { type CSSProperties } from 'react'
import { useI18n } from '@/lib/i18n'

export function PlanFeatureListEditor({ values, disabled, onChange }: { values: readonly string[]; disabled?: boolean; onChange: (values: string[]) => void }) {
  const { t } = useI18n()
  function update(index: number, value: string) {
    onChange(values.map((item, itemIndex) => itemIndex === index ? value : item))
  }

  function remove(index: number) {
    onChange(values.filter((_, itemIndex) => itemIndex !== index))
  }

  return <section style={{ marginTop: 14 }}>
    <div style={sectionHeader}><div><h3 style={heading}>{t('planEditor.visibleHeading')}</h3><p style={help}>{t('planEditor.visibleHelp')}</p></div><button type="button" disabled={disabled} onClick={() => onChange([...values, ''])} style={secondary}><Plus size={14} aria-hidden="true" /> {t('planEditor.addLabel')}</button></div>
    <div style={list}>{values.map((value, index) => <div key={`feature-${index}`} style={row}><input aria-label={`${t('planEditor.displayedFeature')} ${index + 1}`} value={value} disabled={disabled} onChange={event => update(index, event.target.value)} style={input} /><button type="button" aria-label={`${t('planEditor.removeDisplayedFeature')} ${index + 1}`} disabled={disabled} onClick={() => remove(index)} style={icon}><Trash2 size={14} aria-hidden="true" /></button></div>)}</div>
    {values.length === 0 && <p style={empty}>{t('planEditor.noDisplayLabels')}</p>}
  </section>
}

const heading: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--text)' }
const help: CSSProperties = { margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)' }
const sectionHeader: CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }
const list: CSSProperties = { display: 'grid', gap: 8, marginTop: 10 }
const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' }
const input: CSSProperties = { flex: 1, minWidth: 0, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 12 }
const secondary: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--border)', borderRadius: 7, padding: '7px 9px', background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 11, cursor: 'pointer' }
const icon: CSSProperties = { display: 'grid', placeItems: 'center', width: 32, height: 32, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text-muted)', cursor: 'pointer' }
const empty: CSSProperties = { margin: '10px 0 0', fontSize: 11, color: 'var(--text-muted)' }
