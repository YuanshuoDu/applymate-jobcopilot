'use client'

import React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type JobProvider = { key: string; label: string; access: string; maxJobsPerResponse?: number; fullJobData?: boolean; calls: number; jobs: number; errors: number; avgLatency: number; lastEventAt: string | null; operations: Array<{ operation: string; credentialSource: string; calls: number; jobs: number; errors: number }> }
type AiProvider = { provider: string; model: string; credentialSource: string; calls: number; inputTokens: number; outputTokens: number; cost: number; errors: number; avgLatency: number; lastEventAt: string | null }
type ExternalProvider = { key: string; label: string; category: string; access: string; billing: string; telemetry: string; calls: number; inputBytes: number; outputBytes: number; cost: number; errors: number; avgLatency: number; lastEventAt: string | null; source: string; sampledAt: string | null; alertThresholdUsd: number | null; maxBudgetUsd: number | null; alertTriggered: boolean; operations: Array<{ operation: string; credentialSource: string; calls: number; inputBytes: number; outputBytes: number; cost: number; errors: number }> }
type Quota = { id: string; category: string; provider: string; operation: string; metric: string; planName: string; period: string; limit: number; resetDay: number; version: number; used: number; remaining: number; percent: number; periodEnd: string }
type ProviderOption = { key: string; label: string }
type Payload = { generatedAt: string; days: number; provider: string | null; catalog: { job: ProviderOption[]; ai: ProviderOption[]; external: ProviderOption[] }; job: { summary: { calls: number; jobs: number; errors: number; errorRate: number }; providers: JobProvider[] }; ai: { summary: { calls: number; tokens: number; costUsd: number; errors: number; errorRate: number }; providers: AiProvider[] }; external: { summary: { calls: number; dataBytes: number; costUsd: number; errors: number; errorRate: number }; providers: ExternalProvider[] }; quotas: Quota[]; optimization?: { cacheHits: number; singleflightHits: number; providerSkips: number; shadowJobs: number; shadowNetNewJobs: number; shadowValidApplyUrls: number; shadowCompleteDescriptions: number }; trend: Array<{ day: string; category: string; calls: number; units: number; cost: number }> }

const format = (value: number) => new Intl.NumberFormat().format(value)
const formatBytes = (value: number) => value < 1024 ? `${format(value)} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : value < 1024 * 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`

export function AdminApiUsagePage({ canUpdateJob, canUpdateAi }: { canUpdateJob: boolean; canUpdateAi: boolean }) {
  const { t } = useI18n()
  const [category, setCategory] = useState<'job' | 'ai' | 'external'>('job')
  const [days, setDays] = useState(30)
  const [provider, setProvider] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ days: String(days) })
    if (provider) params.set('provider', provider)
    const response = await fetch(`/api/admin/v1/api-usage?${params}`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as Payload | { error?: string } | null
    if (!response.ok || !payload || !('job' in payload)) setError(payload && 'error' in payload ? payload.error ?? t('apiUsage.loadError') : t('apiUsage.loadError'))
    else { setData(payload); setError('') }
    setLoading(false)
  }, [days, provider, t])

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(timer) }, [load])
  const summary = category === 'job' ? data?.job.summary : category === 'ai' ? data?.ai.summary : data?.external.summary
  const trends = useMemo(() => data?.trend.filter(row => row.category === category) ?? [], [category, data])
  const providerOptions = data?.catalog[category] ?? []
  const maxTrend = Math.max(1, ...trends.map(row => row.calls))

  async function saveQuota(quota: Quota, patch: Partial<Quota>) {
    const reason = window.prompt(t('apiUsage.reasonPrompt'))?.trim()
    if (!reason || reason.length < 10) return
    const response = await fetch(`/api/admin/v1/api-usage/quotas/${quota.id}`, {
      method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ planName: patch.planName ?? quota.planName, period: patch.period ?? quota.period, limit: patch.limit ?? quota.limit, resetDay: patch.resetDay ?? quota.resetDay, version: quota.version, reason }),
    })
    if (!response.ok) setError(t('apiUsage.saveError')); else void load()
  }

  return <div className="admin-page">
    <header className="admin-header"><div><h1>{t('apiUsage.title')}</h1><p>{t('apiUsage.subtitle')}</p></div><button className="admin-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={14} />{t('apiUsage.refresh')}</button></header>
    <div className="admin-privacy"><ShieldCheck size={20} /><span><strong>{t('apiUsage.privacyTitle')}</strong> {t('apiUsage.privacy')}</span></div>
    {error && <div className="admin-alert">{error}</div>}
    <main className="api-usage-layout">
      <div className="api-usage-toolbar" role="tablist" aria-label={t('apiUsage.category')}>
        <button role="tab" aria-selected={category === 'job'} data-active={category === 'job'} onClick={() => { setCategory('job'); setProvider('') }}>{t('apiUsage.jobApis')}</button>
        <button role="tab" aria-selected={category === 'ai'} data-active={category === 'ai'} onClick={() => { setCategory('ai'); setProvider('') }}>{t('apiUsage.modelApis')}</button>
        <button role="tab" aria-selected={category === 'external'} data-active={category === 'external'} onClick={() => { setCategory('external'); setProvider('') }}>{t('apiUsage.externalApis')}</button>
        <label>{t('apiUsage.range')}<select value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>7</option><option value={30}>30</option><option value={90}>90</option></select></label>
        <label>{t('apiUsage.filterProvider')}<select aria-label={t('apiUsage.filterProvider')} value={provider} onChange={event => setProvider(event.target.value)}><option value="">{t('apiUsage.allProviders')}</option>{providerOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
        <small>{t('apiUsage.updated')} {data ? new Date(data.generatedAt).toLocaleTimeString() : '—'} · {t('apiUsage.autoRefresh')}</small>
      </div>
      <section className="admin-metric-grid api-usage-metrics">
        <article className="admin-metric"><span>{t('apiUsage.calls')}</span><strong>{format(summary?.calls ?? 0)}</strong><small>{days} {t('apiUsage.days')}</small></article>
        <article className="admin-metric"><span>{category === 'job' ? t('apiUsage.jobsReturned') : category === 'ai' ? t('apiUsage.tokens') : t('apiUsage.data')}</span><strong>{format(category === 'job' ? data?.job.summary.jobs ?? 0 : category === 'ai' ? data?.ai.summary.tokens ?? 0 : data?.external.summary.dataBytes ?? 0)}</strong><small>{category === 'ai' || category === 'external' ? `$${Number(category === 'ai' ? data?.ai.summary.costUsd ?? 0 : data?.external.summary.costUsd ?? 0).toFixed(4)}` : t('apiUsage.rawResults')}</small></article>
        <article className="admin-metric"><span>{t('apiUsage.errors')}</span><strong>{format(summary?.errors ?? 0)}</strong><small>{summary?.errorRate ?? 0}%</small></article>
        <article className="admin-metric"><span>{t('apiUsage.providers')}</span><strong>{category === 'job' ? data?.job.providers.length ?? 0 : category === 'ai' ? data?.ai.providers.length ?? 0 : data?.external.providers.length ?? 0}</strong><small>{t('apiUsage.ownershipTracked')}</small></article>
      </section>
      <section className="api-usage-section"><h2>{t('apiUsage.optimization')}</h2><p>{t('apiUsage.optimizationHelp')}</p><div className="admin-metric-grid api-usage-metrics"><article className="admin-metric"><span>{t('apiUsage.cacheHits')}</span><strong>{format(data?.optimization?.cacheHits ?? 0)}</strong><small>{t('apiUsage.requestsAvoided')}</small></article><article className="admin-metric"><span>{t('apiUsage.singleflightHits')}</span><strong>{format(data?.optimization?.singleflightHits ?? 0)}</strong><small>{t('apiUsage.requestsAvoided')}</small></article><article className="admin-metric"><span>{t('apiUsage.shadowNetNew')}</span><strong>{format(data?.optimization?.shadowNetNewJobs ?? 0)}</strong><small>{format(data?.optimization?.shadowJobs ?? 0)} {t('apiUsage.shadowObserved')}</small></article><article className="admin-metric"><span>{t('apiUsage.shadowQuality')}</span><strong>{data?.optimization?.shadowJobs ? `${Math.round((data.optimization.shadowCompleteDescriptions / data.optimization.shadowJobs) * 100)}%` : '—'}</strong><small>{t('apiUsage.completeDescriptions')}</small></article></div></section>
      {category !== 'external' && <section className="api-usage-section"><h2>{t('apiUsage.quotas')}</h2><p>{t('apiUsage.quotaHelp')}</p><div className="api-quota-grid">{data?.quotas.filter(quota => quota.category === category).map(quota => <QuotaCard key={quota.id} quota={quota} editable={category === 'job' ? canUpdateJob : canUpdateAi} onSave={saveQuota} t={t} />)}</div></section>}
      <section className="api-usage-section"><h2>{t('apiUsage.trend')}</h2><div className="admin-trend-grid">{trends.length ? trends.map(row => <div className="admin-trend-row" key={row.day}><span>{new Date(row.day).toLocaleDateString()}</span><div className="admin-trend-bar"><i style={{ width: `${row.calls / maxTrend * 100}%` }} /></div><strong>{format(row.calls)} {t('apiUsage.callsShort')}</strong></div>) : <p>{t('apiUsage.noData')}</p>}</div></section>
      <section className="api-usage-section"><h2>{t('apiUsage.breakdown')}</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('apiUsage.provider')}</th><th>{t('apiUsage.operationModel')}</th><th>{t('apiUsage.owner')}</th><th>{t('apiUsage.calls')}</th><th>{category === 'job' ? t('apiUsage.jobsReturned') : category === 'ai' ? t('apiUsage.tokens') : t('apiUsage.data')}</th><th>{t('apiUsage.cost')}</th><th>{t('apiUsage.errors')}</th><th>{t('apiUsage.latency')}</th><th>{t('apiUsage.lastEvent')}</th></tr></thead><tbody>{category === 'job' ? data?.job.providers.map(provider => <tr key={provider.key}><td>{provider.label}</td><td>{provider.operations.map(row => row.operation).join(', ') || '—'}{provider.maxJobsPerResponse ? ` · ${t('apiUsage.maxJobs')} ${provider.maxJobsPerResponse}` : ''}{provider.fullJobData ? ` · ${t('apiUsage.fullData')}` : ''}</td><td>{provider.operations.map(row => t(`apiUsage.owner.${row.credentialSource}`)).filter((v, i, a) => a.indexOf(v) === i).join(', ') || t(`apiUsage.owner.${provider.access === 'public' ? 'public' : 'platform'}`)}</td><td>{format(provider.calls)}</td><td>{format(provider.jobs)}</td><td>—</td><td>{format(provider.errors)}</td><td>{format(provider.avgLatency)} ms</td><td>{freshness(provider.lastEventAt, t)}</td></tr>) : category === 'ai' ? data?.ai.providers.map(provider => <tr key={`${provider.provider}-${provider.model}-${provider.credentialSource}`}><td>{provider.provider}</td><td>{provider.model}</td><td>{t(`apiUsage.owner.${provider.credentialSource}`)}</td><td>{format(provider.calls)}</td><td>{format(provider.inputTokens + provider.outputTokens)}</td><td>${provider.cost.toFixed(4)}</td><td>{format(provider.errors)}</td><td>{format(provider.avgLatency)} ms</td><td>{freshness(provider.lastEventAt, t)}</td></tr>) : data?.external.providers.map(provider => <tr key={provider.key}><td>{provider.label}</td><td>{provider.operations.map(row => row.operation).join(', ') || t(`apiUsage.telemetry.${provider.telemetry}`)} · {t(`apiUsage.telemetry.${provider.source}`)}{provider.alertTriggered ? ` · ${t('apiUsage.alertTriggered')}` : ''}</td><td>{t(`apiUsage.owner.${provider.access === 'user' ? 'user' : provider.access === 'internal' ? 'internal' : 'platform'}`)}</td><td>{format(provider.calls)}</td><td>{formatBytes(provider.inputBytes + provider.outputBytes)}</td><td>${provider.cost.toFixed(4)}{provider.alertThresholdUsd !== null ? ` / $${provider.alertThresholdUsd.toFixed(2)}` : ''}{provider.maxBudgetUsd !== null ? ` (${t('apiUsage.budgetCap')} $${provider.maxBudgetUsd.toFixed(2)})` : ''}</td><td>{format(provider.errors)}</td><td>{format(provider.avgLatency)} ms</td><td>{provider.sampledAt ? freshness(provider.sampledAt, t) : freshness(provider.lastEventAt, t)}</td></tr>)}</tbody></table></div></section>
    </main>
  </div>
}

function freshness(value: string | null, t: (key: string) => string): React.ReactNode {
  if (!value) return t('apiUsage.never')
  const date = new Date(value)
  const age = Date.now() - date.getTime()
  const state = age <= 5 * 60_000 ? 'live' : age <= 60 * 60_000 ? 'recent' : 'stale'
  return <span title={date.toLocaleString()}>{date.toLocaleString()} · {t(`apiUsage.fresh.${state}`)}</span>
}

function QuotaCard({ quota, editable, onSave, t }: { quota: Quota; editable: boolean; onSave: (quota: Quota, patch: Partial<Quota>) => Promise<void>; t: (key: string) => string }) {
  const [limit, setLimit] = useState(quota.limit)
  const [planName, setPlanName] = useState(quota.planName)
  const warning = quota.percent >= 90 ? 'danger' : quota.percent >= 75 ? 'warning' : 'ok'
  return <article className="api-quota-card" data-status={warning}><div><strong>{quota.provider}</strong><span>{quota.operation} · {t(`apiUsage.metric.${quota.metric}`)} · {t(`apiUsage.period.${quota.period}`)}</span></div><label>{t('apiUsage.plan')}<input value={planName} onChange={event => setPlanName(event.target.value)} disabled={!editable} /></label><label>{t('apiUsage.limit')}<input type="number" min={0} value={limit} onChange={event => setLimit(Number(event.target.value))} disabled={!editable} /></label><div className="api-quota-progress"><i style={{ width: `${Math.min(100, quota.percent)}%` }} /></div><p>{format(quota.used)} / {format(quota.limit)} · {quota.percent}% · {t('apiUsage.resets')} {new Date(quota.periodEnd).toLocaleDateString()}</p>{editable && <button className="admin-secondary" onClick={() => void onSave(quota, { limit, planName })}>{t('apiUsage.save')}</button>}</article>
}
