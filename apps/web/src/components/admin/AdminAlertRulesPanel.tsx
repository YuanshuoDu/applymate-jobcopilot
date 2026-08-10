'use client'

import { useState, type FormEvent } from 'react'
import { apiMutate, useApi } from '@/lib/hooks'
import { useAdminPrompt } from './AdminPromptDialog'

type AlertRule = { id: string; key: string; name: string; metric: string; operator: string; threshold: number; windowMin: number; severity: string; enabled: boolean }
type AlertData = { rules: AlertRule[]; events: Array<{ id: string; ruleKey: string; value: number; threshold: number; severity: string; status: string; createdAt: string }> }

const metricOptions = [
  ['success_rate', 'Success rate'],
  ['captcha_rate', 'CAPTCHA rate'],
  ['avg_duration_ms', 'Average duration'],
  ['ai_error_rate', 'AI error rate'],
  ['ai_cost_usd', 'AI cost'],
  ['queue_stuck_jobs', 'Stuck queue jobs'],
  ['queue_failed_jobs', 'Failed queue jobs'],
  ['queue_dead_letter_jobs', 'Dead-letter queue jobs'],
] as const

export function AdminAlertRulesPanel({ canManage }: { canManage: boolean }) {
  const { data, loading, error, refetch } = useApi<AlertData>('/api/admin/v1/observability/alerts')
  const { request, dialog } = useAdminPrompt()
  const [form, setForm] = useState({ key: '', name: '', metric: 'success_rate', operator: 'lt', threshold: '80', windowMin: '60', severity: 'medium' })
  const [notice, setNotice] = useState('')

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = await request({ title: 'Save alert threshold', label: 'Reason', kind: 'reason', description: 'Alert rule changes are audited and take effect on the next evaluation run.', submitLabel: 'Save rule' })
    if (!reason) return
    const result = await apiMutate('/api/admin/v1/observability/alerts', 'POST', { ...form, threshold: Number(form.threshold), windowMin: Number(form.windowMin), enabled: true, reason })
    setNotice(result.error ?? 'Alert rule saved.')
    if (!result.error) { setForm(current => ({ ...current, key: '', name: '' })); await refetch() }
  }

  return <><section className="admin-controls"><div className="admin-controls-title"><div><h2>Alert thresholds</h2><p>Rules are evaluated every five minutes and open an incident when breached.</p></div><span role="status">{notice || error || (loading ? 'Loading…' : '')}</span></div>{canManage && <form className="admin-filter-panel" onSubmit={(event) => void save(event)}><label>Key<input required pattern="[a-z][a-z0-9_.-]{2,80}" value={form.key} onChange={event => setForm(current => ({ ...current, key: event.target.value }))} placeholder="auto_apply.success_rate" /></label><label>Name<input required maxLength={120} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder="Auto-apply success rate" /></label><label>Metric<select value={form.metric} onChange={event => setForm(current => ({ ...current, metric: event.target.value }))}>{metricOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Operator<select value={form.operator} onChange={event => setForm(current => ({ ...current, operator: event.target.value }))}><option value="lt">Below</option><option value="lte">At or below</option><option value="gt">Above</option><option value="gte">At or above</option></select></label><label>Threshold<input type="number" value={form.threshold} onChange={event => setForm(current => ({ ...current, threshold: event.target.value }))} required /></label><label>Window (minutes)<input type="number" min="1" max="10080" value={form.windowMin} onChange={event => setForm(current => ({ ...current, windowMin: event.target.value }))} required /></label><label>Severity<select value={form.severity} onChange={event => setForm(current => ({ ...current, severity: event.target.value }))}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label><button className="admin-primary-button" type="submit">Save threshold</button></form>}<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Rule</th><th>Metric</th><th>Condition</th><th>Severity</th><th>State</th></tr></thead><tbody>{(data?.rules ?? []).length ? (data?.rules ?? []).map(rule => <tr key={rule.id}><td>{rule.name}<small>{rule.key}</small></td><td>{rule.metric}</td><td>{rule.operator} {rule.threshold} / {rule.windowMin}m</td><td>{rule.severity}</td><td>{rule.enabled ? 'Enabled' : 'Disabled'}</td></tr>) : <tr><td colSpan={5}>No alert rules configured.</td></tr>}</tbody></table></div>{(data?.events ?? []).length ? <p className="admin-settings-integration-note">Latest alert: {data?.events[0].ruleKey} · {data?.events[0].value} · {data?.events[0].status} · {new Date(data?.events[0].createdAt ?? '').toLocaleString()}</p> : null}</section>{dialog}</>
}
