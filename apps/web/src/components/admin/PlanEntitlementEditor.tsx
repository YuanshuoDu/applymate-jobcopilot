'use client'

import { Plus, Trash2 } from 'lucide-react'
import type { CSSProperties } from 'react'
import React, { useEffect, useState } from 'react'
import { createEntitlementDraft, encodeEntitlements, getEntitlementDefinition, parseEntitlements, PLAN_ENTITLEMENT_DEFINITIONS, type PlanEntitlementDraft, type PlanEntitlementKind } from '@/lib/plan-entitlement-editor'

const CUSTOM_KEY = '__custom__'
const kindLabels: Record<PlanEntitlementKind, string> = { boolean: 'Enabled', limit: 'Limited', unlimited: 'Unlimited', text: 'Named level' }

export function PlanEntitlementEditor({ values, disabled, onChange }: { values: readonly string[]; disabled?: boolean; onChange: (values: string[]) => void }) {
  const [drafts, setDrafts] = useState<PlanEntitlementDraft[]>(() => parseEntitlements(values))
  const [error, setError] = useState('')

  useEffect(() => { setDrafts(parseEntitlements(values)); setError('') }, [values])

  function commit(next: PlanEntitlementDraft[]) {
    setDrafts(next)
    try { onChange(encodeEntitlements(next)); setError('') } catch (commitError) { setError(commitError instanceof Error ? commitError.message : 'Fix the permission values before saving.') }
  }

  function patch(index: number, change: Partial<PlanEntitlementDraft>) {
    commit(drafts.map((draft, draftIndex) => draftIndex === index ? { ...draft, ...change } : draft))
  }

  function changeKey(index: number, value: string) {
    if (value === CUSTOM_KEY) { patch(index, { key: 'custom_permission', kind: 'boolean', value: '', unit: '' }); return }
    const definition = getEntitlementDefinition(value)
    patch(index, { key: value, kind: definition?.kind ?? 'boolean', value: definition?.kind === 'limit' ? 0 : definition?.options?.[0]?.value ?? '', unit: definition?.defaultUnit ?? '' })
  }

  function add() {
    const key = PLAN_ENTITLEMENT_DEFINITIONS.find(item => !drafts.some(draft => draft.key === item.key))?.key ?? 'custom_permission'
    commit([...drafts, createEntitlementDraft(key, `entitlement-${Date.now()}`)])
  }

  return <section style={{ marginTop: 22 }}>
    <div style={sectionHeader}><div><h3 style={heading}>What users can actually use</h3><p style={help}>These structured permissions control runtime access and limits. They are separate from display labels.</p></div><button type="button" disabled={disabled} onClick={add} style={secondary}><Plus size={14} aria-hidden="true" /> Add permission</button></div>
    <div style={list}>{drafts.map((draft, index) => {
      const definition = getEntitlementDefinition(draft.key)
      const kindOptions: PlanEntitlementKind[] = definition?.kind === 'limit' ? ['limit', 'unlimited'] : definition ? [definition.kind] : ['boolean', 'limit', 'unlimited', 'text']
      return <div key={draft.id} style={card}>
        <div style={row}><select aria-label={`Permission ${index + 1}`} value={definition ? draft.key : CUSTOM_KEY} disabled={disabled} onChange={event => changeKey(index, event.target.value)} style={input}>{PLAN_ENTITLEMENT_DEFINITIONS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}<option value={CUSTOM_KEY}>Custom permission…</option></select><button type="button" aria-label={`Remove permission ${index + 1}`} disabled={disabled} onClick={() => commit(drafts.filter((_, draftIndex) => draftIndex !== index))} style={icon}><Trash2 size={14} aria-hidden="true" /></button></div>
        {!definition && <input aria-label={`Custom permission key ${index + 1}`} value={draft.key} disabled={disabled} onChange={event => patch(index, { key: event.target.value })} placeholder="lowercase_permission_key" style={{ ...input, marginTop: 8 }} />}
        <div style={valueRow}><select aria-label={`Permission type ${index + 1}`} value={draft.kind} disabled={disabled || kindOptions.length === 1} onChange={event => patch(index, { kind: event.target.value as PlanEntitlementKind, value: event.target.value === 'limit' ? 0 : definition?.options?.[0]?.value ?? '' })} style={smallInput}>{kindOptions.map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select>{draft.kind === 'limit' && <><input aria-label={`Limit for permission ${index + 1}`} type="number" min="0" step="1" value={String(draft.value)} disabled={disabled} onChange={event => patch(index, { value: Number(event.target.value) })} style={smallInput} /><select aria-label={`Limit period for permission ${index + 1}`} value={draft.unit} disabled={disabled} onChange={event => patch(index, { unit: event.target.value as 'month' | '' })} style={smallInput}><option value="">Total</option><option value="month">Per month</option></select></>}{draft.kind === 'text' && (definition?.options ? <select aria-label={`Value for permission ${index + 1}`} value={String(draft.value)} disabled={disabled} onChange={event => patch(index, { value: event.target.value })} style={smallInput}>{definition.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input aria-label={`Value for permission ${index + 1}`} value={String(draft.value)} disabled={disabled} onChange={event => patch(index, { value: event.target.value })} placeholder="Permission level" style={smallInput} />)}{draft.kind === 'boolean' && <span style={enabled}>Enabled for this plan</span>}{draft.kind === 'unlimited' && <span style={enabled}>No numeric limit</span>}</div>
      </div>
    })}</div>
    {drafts.length === 0 && <p style={empty}>No runtime permissions. Add one to grant access.</p>}
    {error && <p role="alert" style={errorStyle}>{error}</p>}
  </section>
}

const heading: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--text)' }
const help: CSSProperties = { margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)' }
const sectionHeader: CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }
const list: CSSProperties = { display: 'grid', gap: 9, marginTop: 10 }
const card: CSSProperties = { padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'color-mix(in srgb, var(--bg) 92%, var(--primary) 8%)' }
const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' }
const valueRow: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }
const input: CSSProperties = { flex: 1, minWidth: 0, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 12 }
const smallInput: CSSProperties = { minWidth: 130, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 12 }
const secondary: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--border)', borderRadius: 7, padding: '7px 9px', background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 11, cursor: 'pointer' }
const icon: CSSProperties = { display: 'grid', placeItems: 'center', width: 32, height: 32, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text-muted)', cursor: 'pointer' }
const enabled: CSSProperties = { fontSize: 11, color: 'var(--c-success)' }
const empty: CSSProperties = { margin: '10px 0 0', fontSize: 11, color: 'var(--text-muted)' }
const errorStyle: CSSProperties = { margin: '10px 0 0', fontSize: 11, color: 'var(--c-danger)' }
