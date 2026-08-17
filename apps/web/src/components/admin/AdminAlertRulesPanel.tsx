'use client'

import { useState, type FormEvent } from 'react'
import { apiMutate, useApi } from '@/lib/hooks'
import { useAdminPrompt } from './AdminPromptDialog'
import { useI18n } from '@/lib/i18n'

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
  const { t } = useI18n()
  const { data, loading, error, refetch } = useApi<AlertData>('/api/admin/v1/observability/alerts')
  const { request, dialog } = useAdminPrompt()
  const [form, setForm] = useState({ key: '', name: '', metric: 'success_rate', operator: 'lt', threshold: '80', windowMin: '60', severity: 'medium' })
  const [notice, setNotice] = useState('')

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = await request({ title: t('alertRules.saveThreshold'), label: t('alertRules.reason'), kind: 'reason', description: t('alertRules.descriptionAudit'), submitLabel: t('alertRules.saveRule') })
    if (!reason) return
    const result = await apiMutate('/api/admin/v1/observability/alerts', 'POST', { ...form, threshold: Number(form.threshold), windowMin: Number(form.windowMin), enabled: true, reason })
    setNotice(result.error ?? t('alertRules.saved'))
    if (!result.error) { setForm(current => ({ ...current, key: '', name: '' })); await refetch() }
  }

  return <><section className="admin-controls"><div className="admin-controls-title"><div><h2>{t('alertRules.title')}</h2><p>{t('alertRules.description')}</p></div><span role="status">{notice || error || (loading ? t('common.loading') : '')}</span></div>{canManage && <form className="admin-filter-panel" onSubmit={(event) => void save(event)}><label>{t('alertRules.key')}<input required pattern="[a-z][a-z0-9_.-]{2,80}" value={form.key} onChange={event => setForm(current => ({ ...current, key: event.target.value }))} placeholder="auto_apply.success_rate" /></label><label>{t('alertRules.name')}<input required maxLength={120} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder={t('alertRules.namePlaceholder')} /></label><label>{t('alertRules.metric')}<select value={form.metric} onChange={event => setForm(current => ({ ...current, metric: event.target.value }))}>{metricOptions.map(([value, label]) => <option key={value} value={value}>{t(`alertRules.metric.${value}`)}</option>)}</select></label><label>{t('alertRules.operator')}<select value={form.operator} onChange={event => setForm(current => ({ ...current, operator: event.target.value }))}><option value="lt">{t('alertRules.below')}</option><option value="lte">{t('alertRules.atOrBelow')}</option><option value="gt">{t('alertRules.above')}</option><option value="gte">{t('alertRules.atOrAbove')}</option></select></label><label>{t('alertRules.threshold')}<input type="number" value={form.threshold} onChange={event => setForm(current => ({ ...current, threshold: event.target.value }))} required /></label><label>{t('alertRules.window')}<input type="number" min="1" max="10080" value={form.windowMin} onChange={event => setForm(current => ({ ...current, windowMin: event.target.value }))} required /></label><label>{t('alertRules.severity')}<select value={form.severity} onChange={event => setForm(current => ({ ...current, severity: event.target.value }))}><option value="low">{t('admin.incidents.low')}</option><option value="medium">{t('admin.incidents.medium')}</option><option value="high">{t('admin.incidents.high')}</option><option value="critical">{t('admin.incidents.critical')}</option></select></label><button className="admin-primary-button" type="submit">{t('alertRules.saveThreshold')}</button></form>}<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('alertRules.rule')}</th><th>{t('alertRules.metric')}</th><th>{t('alertRules.condition')}</th><th>{t('alertRules.severity')}</th><th>{t('alertRules.state')}</th></tr></thead><tbody>{(data?.rules ?? []).length ? (data?.rules ?? []).map(rule => <tr key={rule.id}><td>{rule.name}<small>{rule.key}</small></td><td>{rule.metric}</td><td>{rule.operator} {rule.threshold} / {rule.windowMin}m</td><td>{rule.severity}</td><td>{rule.enabled ? t('admin.enabled') : t('admin.disabled')}</td></tr>) : <tr><td colSpan={5}>{t('alertRules.empty')}</td></tr>}</tbody></table></div>{(data?.events ?? []).length ? <p className="admin-settings-integration-note">{t('alertRules.latest')}: {data?.events[0].ruleKey} · {data?.events[0].value} · {data?.events[0].status} · {new Date(data?.events[0].createdAt ?? '').toLocaleString()}</p> : null}</section>{dialog}</>
}
