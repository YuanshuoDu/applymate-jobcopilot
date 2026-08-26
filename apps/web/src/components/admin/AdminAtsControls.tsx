'use client'

import { Pause, Play, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'
import { toAtsPolicyPayload } from './admin-ats-policy-form'
import { useAdminPrompt } from './AdminPromptDialog'

type Policy = {
  configured: boolean
  state: string
  enabled: boolean
  rolloutPercent: number
  globalRpsLimit: number
  perTenantRpsLimit: number
  maxRetries: number
  backoffBaseMs: number
  allowAutoApply: boolean
  version: number
  lastAcknowledgedVersion: number | null
}
type Source = { sourceKey: string; policy: Policy; propagation: string; registryCount: number; lastSeenAt: string | null }
type HistoryEvent = { id: string; sourceKey: string; action: string; outcome: string; reason: string | null; createdAt: string }
const sources = ['greenhouse', 'lever', 'workday', 'smartrecruiters', 'personio']

export function AdminAtsControls({ permissions }: { permissions: readonly string[] }) {
  const { t } = useI18n()
  const [items, setItems] = useState<Source[]>([])
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [history, setHistory] = useState<HistoryEvent[]>([])
  const [historySource, setHistorySource] = useState('')
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const { request: askReason, dialog } = useAdminPrompt()
  const can = (permission: string) => permissions.includes(permission)
  const stateLabel = (state: string) => state === 'paused' ? t('adminAts.state.paused') : ['enabled', 'degraded'].includes(state) ? t('adminAts.state.active') : t('adminAts.state.pending')
  const propagationLabel = (value: string) => value === 'acknowledged' ? t('adminAts.propagation.acknowledged') : value === 'pending' ? t('adminAts.propagation.pending') : t('adminAts.propagation.notConfigured')
  const actionLabel = (value: string) => value === 'ats.pause' ? t('adminAts.action.pause') : value === 'ats.resumed' ? t('adminAts.action.resume') : value === 'ats.policy_updated' ? t('adminAts.action.policyUpdated') : t('adminAts.action.other')
  const outcomeLabel = (value: string) => value === 'success' ? t('adminAts.outcome.success') : value === 'failed' ? t('adminAts.outcome.failed') : value === 'denied' ? t('adminAts.outcome.denied') : t('adminAts.outcome.other')

  async function load() {
    setLoading(true)
    setLoadError('')
    try {
      const responses = await Promise.all(sources.map(async sourceKey => {
        const response = await fetch(`/api/admin/v1/ats/${sourceKey}/health`, { cache: 'no-store' })
        if (!response.ok) return null
        return await response.json() as Source
      }))
      const available = responses.filter((item): item is Source => Boolean(item))
      setItems(available)
      if (available.length !== sources.length) setLoadError(t('adminAts.controlsLoadFailed'))
    } catch {
      setItems([])
      setLoadError(t('adminAts.controlsLoadFailed'))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  async function request(url: string, body: Record<string, unknown>) {
    const reason = await askReason({ title: t('adminAts.changeState'), label: t('adminAts.operationalReason'), kind: 'reason' })
    if (!reason) return false
    const response = await fetch(url, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ ...body, reason }) })
    const payload = await response.json().catch(() => null) as { error?: string; state?: string } | null
    setNotice(response.ok ? `${t('adminAts.sourceState')}: ${stateLabel(payload?.state ?? 'pending')}.` : payload?.error ?? t('adminAts.operationFailed'))
    return response.ok
  }
  async function save(source: Source) {
    const reason = await askReason({ title: t('adminAts.savePolicy'), label: t('adminAts.policyReason'), kind: 'reason' })
    if (!reason) return
    const response = await fetch(`/api/admin/v1/ats/${source.sourceKey}/policy`, { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ ...toAtsPolicyPayload(source.policy), reason }) })
    const payload = await response.json().catch(() => null) as { error?: string; propagation?: string } | null
    setNotice(response.ok ? t('adminAts.policySaved').replace('{state}', propagationLabel(payload?.propagation ?? 'pending')) : payload?.error ?? t('adminAts.policyFailed'))
    if (response.ok) await load()
  }
  async function loadHistory(sourceKey: string) {
    setHistorySource(sourceKey)
    setHistoryLoaded(false)
    try {
      const response = await fetch(`/api/admin/v1/ats/${sourceKey}/history`, { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as { events?: Omit<HistoryEvent, 'sourceKey'>[]; error?: string } | null
      setHistory(response.ok ? (payload?.events ?? []).map(event => ({ ...event, sourceKey })) : [])
      setHistoryLoaded(response.ok)
      if (!response.ok) setNotice(payload?.error ?? t('adminAts.historyFailed'))
    } catch {
      setHistory([])
      setHistoryLoaded(true)
      setNotice(t('adminAts.historyFailed'))
    }
  }
  function update(sourceKey: string, patch: Partial<Policy>) {
    setItems(current => current.map(item => item.sourceKey === sourceKey ? { ...item, policy: { ...item.policy, ...patch } } : item))
  }

  return <><section className="admin-controls"><div className="admin-controls-title"><div><h2>{t('adminAts.sourcePolicy')}</h2><p>{t('adminAts.hardCeilings')}</p></div><span role="status" aria-live="polite">{notice}</span></div>
    {loadError && <div className="admin-alert ats-inline-alert">{loadError}<button className="admin-secondary" type="button" onClick={() => void load()}>{t('common.retry')}</button></div>}
    {loading ? <p>{t('admin.loadingSafeData')}</p> : <div className="ats-control-grid">{items.map(source => <article className="ats-control" key={source.sourceKey}><div className="ats-control-heading"><div><h3>{source.sourceKey}</h3><small>{source.registryCount} {t('adminAts.employers')} · {stateLabel(source.policy.state)} · {source.policy.configured ? propagationLabel(source.propagation) : t('adminAts.defaultPolicy')}</small></div>{source.policy.state === 'paused' ? <button className="admin-row-action" title={t('adminAts.resumeSource')} disabled={!can('ats.resume')} onClick={async () => { if (await request(`/api/admin/v1/ats/${source.sourceKey}/resume`, { version: source.policy.version })) await load() }}><Play size={15} /></button> : <button className="admin-row-action" title={t('adminAts.pauseSource')} disabled={!can('ats.pause')} onClick={async () => { if (await request(`/api/admin/v1/ats/${source.sourceKey}/pause`, {})) await load() }}><Pause size={15} /></button>}</div>
      <div className="ats-control-fields"><label>{t('adminAts.rollout')}<input type="number" min="0" max="100" value={source.policy.rolloutPercent} onChange={event => update(source.sourceKey, { rolloutPercent: Number(event.target.value) })} /></label><label>{t('adminAts.globalRps')}<input type="number" min="1" value={source.policy.globalRpsLimit} onChange={event => update(source.sourceKey, { globalRpsLimit: Number(event.target.value) })} /></label><label>{t('adminAts.tenantRps')}<input type="number" min="1" value={source.policy.perTenantRpsLimit} onChange={event => update(source.sourceKey, { perTenantRpsLimit: Number(event.target.value) })} /></label><label>{t('adminAts.retries')}<input type="number" min="0" max="10" value={source.policy.maxRetries} onChange={event => update(source.sourceKey, { maxRetries: Number(event.target.value) })} /></label><label>{t('adminAts.backoff')}<input type="number" min="100" max="120000" value={source.policy.backoffBaseMs} onChange={event => update(source.sourceKey, { backoffBaseMs: Number(event.target.value) })} /></label><label className="flag-check"><input type="checkbox" checked={source.policy.allowAutoApply} onChange={event => update(source.sourceKey, { allowAutoApply: event.target.checked })} /> {t('adminAts.allowAutoApply')}</label></div>
      <span className="admin-action-group"><button className="admin-secondary" disabled={!can('ats.update') || ['paused', 'pending_pause', 'disabled'].includes(source.policy.state)} onClick={() => void save(source)}><Save size={15} /> {t('adminAts.savePolicyButton')}</button><button className="admin-secondary" onClick={() => void loadHistory(source.sourceKey)}>{t('adminAts.history')}</button></span>
    </article>)}</div>}
    {historySource && <section className="admin-detail-history"><h3>{t('adminAts.policyHistory')} · {historySource}</h3>{!historyLoaded ? <p>{t('common.loading')}</p> : history.length === 0 ? <p>{t('adminAts.historyEmpty')}</p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('admin.action')}</th><th>{t('admin.outcome')}</th><th>{t('admin.reason')}</th><th>{t('admin.time')}</th></tr></thead><tbody>{history.map(event => <tr key={event.id}><td>{actionLabel(event.action)}</td><td>{outcomeLabel(event.outcome)}</td><td>{event.reason ?? '—'}</td><td>{new Date(event.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</section>}
  </section>{dialog}</>
}
