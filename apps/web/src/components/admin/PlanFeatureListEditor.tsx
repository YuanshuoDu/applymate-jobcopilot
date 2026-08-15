'use client'

import { Plus, Trash2 } from 'lucide-react'
import React, { type CSSProperties } from 'react'

export function PlanFeatureListEditor({ values, disabled, onChange }: { values: readonly string[]; disabled?: boolean; onChange: (values: string[]) => void }) {
  function update(index: number, value: string) {
    onChange(values.map((item, itemIndex) => itemIndex === index ? value : item))
  }

  function remove(index: number) {
    onChange(values.filter((_, itemIndex) => itemIndex !== index))
  }

  return <section style={{ marginTop: 14 }}>
    <div style={sectionHeader}><div><h3 style={heading}>What users see</h3><p style={help}>Short display labels for the pricing card. These do not control access.</p></div><button type="button" disabled={disabled} onClick={() => onChange([...values, ''])} style={secondary}><Plus size={14} aria-hidden="true" /> Add label</button></div>
    <div style={list}>{values.map((value, index) => <div key={`feature-${index}`} style={row}><input aria-label={`Displayed feature ${index + 1}`} value={value} disabled={disabled} onChange={event => update(index, event.target.value)} style={input} /><button type="button" aria-label={`Remove displayed feature ${index + 1}`} disabled={disabled} onClick={() => remove(index)} style={icon}><Trash2 size={14} aria-hidden="true" /></button></div>)}</div>
    {values.length === 0 && <p style={empty}>No display labels. Add one if this plan should show feature highlights.</p>}
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
