'use client'

import React from 'react'
import { apiMutate } from '@/lib/hooks'
import type { AgentAutomation } from './AutomationRow'

interface FormState {
  name: string
  triggerType: string
  time: string
  targetRoles: string
  targetLocations: string
  minScore: number
  dailyCap: number
  requireApproval: boolean
  autoApply: boolean
}

const DEFAULT_FORM: FormState = {
  name: 'Weekday Berlin SWE Scout',
  triggerType: 'weekdays',
  time: '09:00',
  targetRoles: 'Software Engineer',
  targetLocations: 'Berlin',
  minScore: 85,
  dailyCap: 8,
  requireApproval: true,
  autoApply: false,
}

function csv(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function cronFor(triggerType: string, time: string) {
  if (triggerType === 'manual') return null
  const [hourRaw, minuteRaw] = time.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (triggerType === 'weekdays') return `${minute} ${hour} * * 1-5`
  if (triggerType === 'daily') return `${minute} ${hour} * * *`
  return null
}

function timeFromCron(cron: string | null) {
  if (!cron) return '09:00'
  const [minute, hour] = cron.trim().split(/\s+/)
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute)) return '09:00'
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}

function formFromAutomation(row: AgentAutomation): FormState {
  return {
    name: row.name,
    triggerType: row.triggerType,
    time: timeFromCron(row.cron),
    targetRoles: row.targetRoles.join(', '),
    targetLocations: row.targetLocations.join(', '),
    minScore: row.minScore,
    dailyCap: row.dailyCap,
    requireApproval: row.requireApproval,
    autoApply: row.autoApply,
  }
}

export function AutomationCreateModal({
  open,
  onClose,
  onSaved,
  onAskAgent,
  automation,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  onAskAgent: () => void
  automation?: AgentAutomation | null
}) {
  const editing = Boolean(automation)
  const [form, setForm] = React.useState<FormState>(() => automation ? formFromAutomation(automation) : DEFAULT_FORM)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) {
      setForm(automation ? formFromAutomation(automation) : DEFAULT_FORM)
      setError(null)
      setSaving(false)
    }
  }, [automation, open])

  if (!open) return null

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(current => ({ ...current, [key]: value }))
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const name = form.name.trim()
    if (!name) {
      setError('Automation name is required.')
      return
    }

    setSaving(true)
    setError(null)
    const payload = {
      name,
      triggerType: form.triggerType,
      cron: cronFor(form.triggerType, form.time),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin',
      targetRoles: csv(form.targetRoles),
      targetLocations: csv(form.targetLocations),
      minScore: form.minScore,
      dailyCap: form.dailyCap,
      requireApproval: form.requireApproval,
      autoApply: form.autoApply,
      createdBy: 'user',
    }
    try {
      const { error: saveError } = await apiMutate(
        editing ? `/api/agent/automations/${automation?.id}` : '/api/agent/automations',
        editing ? 'PATCH' : 'POST',
        payload,
      )

      if (saveError) {
        setError(saveError)
        return
      }

      onSaved()
      onClose()
    } catch (error) {
      setError((error as Error).message || 'Automation save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={backdropStyle} role="dialog" aria-modal="true" aria-label={editing ? 'Edit automation' : 'Create automation'}>
      <form onSubmit={submit} style={modalStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 750, color: 'var(--text)' }}>{editing ? 'Edit automation' : 'Create automation'}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>{editing ? 'Update this agent routine.' : 'Manual setup for agent routines.'}</div>
          </div>
          <button type="button" onClick={onClose} style={iconButtonStyle} aria-label="Close">x</button>
        </div>

        <Field label="Name">
          <input value={form.name} onChange={e => update('name', e.target.value)} style={inputStyle} autoFocus />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 92px', gap: 9 }}>
          <Field label="Trigger">
            <select value={form.triggerType} onChange={e => update('triggerType', e.target.value)} style={inputStyle}>
              <option value="weekdays">Weekdays</option>
              <option value="daily">Daily</option>
              <option value="manual">Manual only</option>
            </select>
          </Field>
          <Field label="Time">
            <input type="time" value={form.time} onChange={e => update('time', e.target.value)} disabled={form.triggerType === 'manual'} style={inputStyle} />
          </Field>
        </div>

        <Field label="Roles">
          <input value={form.targetRoles} onChange={e => update('targetRoles', e.target.value)} placeholder="Software Engineer, Backend Engineer" style={inputStyle} />
        </Field>
        <Field label="Locations">
          <input value={form.targetLocations} onChange={e => update('targetLocations', e.target.value)} placeholder="Berlin, Amsterdam" style={inputStyle} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
          <Field label={`Score ${form.minScore}+`}>
            <input type="range" min={0} max={100} value={form.minScore} onChange={e => update('minScore', Number(e.target.value))} style={{ width: '100%' }} />
          </Field>
          <Field label="Daily cap">
            <input type="number" min={1} max={50} value={form.dailyCap} onChange={e => update('dailyCap', Number(e.target.value))} style={inputStyle} />
          </Field>
        </div>

        <label style={checkStyle}>
          <input type="checkbox" checked={form.requireApproval} onChange={e => update('requireApproval', e.target.checked)} />
          Require approval before external actions
        </label>
        <label style={checkStyle}>
          <input type="checkbox" checked={form.autoApply} onChange={e => update('autoApply', e.target.checked)} />
          Allow auto-apply after approval gates
        </label>

        {error && <div style={errorStyle}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 14 }}>
          {!editing && <button type="button" onClick={onAskAgent} style={secondaryButtonStyle}>Ask agent instead</button>}
          {editing && <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} style={secondaryButtonStyle}>Cancel</button>
            <button type="submit" disabled={saving} style={{ ...primaryButtonStyle, opacity: saving ? 0.7 : 1 }}>
              {saving ? (editing ? 'Saving...' : 'Creating...') : (editing ? 'Save' : 'Create')}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 9 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  )
}

const backdropStyle: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(15,23,42,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }
const modalStyle: React.CSSProperties = { width: 420, maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg)', boxShadow: '0 24px 70px rgba(15,23,42,0.28)', padding: 16 }
const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', height: 32, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', padding: '0 9px', fontSize: 11, fontFamily: 'inherit' }
const checkStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text)', marginTop: 8 }
const iconButtonStyle: React.CSSProperties = { width: 26, height: 26, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: 'pointer' }
const primaryButtonStyle: React.CSSProperties = { height: 32, border: 'none', borderRadius: 7, background: 'var(--primary)', color: '#fff', padding: '0 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }
const secondaryButtonStyle: React.CSSProperties = { height: 32, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)', color: 'var(--text)', padding: '0 12px', fontSize: 11, cursor: 'pointer' }
const errorStyle: React.CSSProperties = { marginTop: 10, padding: '8px 9px', borderRadius: 7, border: '1px solid rgba(239,68,68,0.30)', background: 'rgba(239,68,68,0.08)', color: 'var(--c-danger)', fontSize: 11 }
