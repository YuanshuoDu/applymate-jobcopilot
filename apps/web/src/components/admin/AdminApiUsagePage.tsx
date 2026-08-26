'use client'

import React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type JobProvider = { key: string; label: string; access: string; maxJobsPerResponse?: number; fullJobData?: boolean; calls: number; jobs: number; errors: number; avgLatency: number; lastEventAt: string | null; operations: Array<{ operation: string; credentialSource: string; calls: number; jobs: number; errors: number }> }
type AiProvider = { provider: string; model: string; credentialSource: string; calls: number; inputTokens: number; outputTokens: number; cost: number; errors: number; avgLatency: number; lastEventAt: string | null }
type UserSummary = { userId: string; category: 'job' | 'ai'; calls: number; jobs: number; tokens: number; cost: number; errors: number; avgLatency: number; lastEventAt: string | null }
type UserDetail = UserSummary & { provider: string; operationModel: string; featureKey: string | null; runtime: string; credentialSource: string }
type Quota = { id: string; category: string; provider: string; operation: string; metric: string; planName: string; period: string; limit: number; resetDay: number; version: number; used: number; remaining: number; percent: number; periodEnd: string }
type ProviderOption = { key: string; label: string }
type Payload = {
  generatedAt: string; days: number; provider: string | null; selectedUserId: string | null
  catalog: { job: ProviderOption[]; ai: ProviderOption[] }
  job: { summary: { calls: number; jobs: number; errors: number; errorRate: number }; providers: JobProvider[] }
  ai: { summary: { calls: number; tokens: number; costUsd: number; errors: number; errorRate: number }; providers: AiProvider[] }
  users: UserSummary[]; userDetails: UserDetail[]; quotas: Quota[]
  trend: Array<{ day: string; category: string; calls: number; units: number; cost: number }>
}

const format = (value: number) => new Intl.NumberFormat().format(value)

export function AdminApiUsagePage({ canUpdateJob, canUpdateAi }: { canUpdateJob: boolean; canUpdateAi: boolean }) {
  const { t } = useI18n()
  const [category, setCategory] = useState<'job' | 'ai'>('job')
  const [days, setDays] = useState(30)
  const [provider, setProvider] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ days: String(days) })
    if (provider) params.set('provider', provider)
    if (selectedUserId) params.set('userId', selectedUserId)
    const response = await fetch(`/api/admin/v1/api-usage?${params}`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as Payload | { error?: string } | null
    if (!response.ok || !payload || !('job' in payload)) setError(payload && 'error' in payload ? payload.error ?? t('apiUsage.loadError') : t('apiUsage.loadError'))
    else { setData(payload); setError('') }
    setLoading(false)
  }, [days, provider, selectedUserId, t])

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(timer) }, [load])
  const summary = category === 'job' ? data?.job.summary : data?.ai.summary
  const trends = useMemo(() => data?.trend.filter(row => row.category === category) ?? [], [category, data])
  const providerOptions = data?.catalog[category] ?? []
  const users = useMemo(() => (data?.users ?? []).filter(row => row.category === category), [category, data])
  const details = useMemo(() => (data?.userDetails ?? []).filter(row => row.category === category), [category, data])
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
        <button role="tab" aria-selected={category === 'job'} data-active={category === 'job'} onClick={() => { setCategory('job'); setProvider(''); setSelectedUserId('') }}>{t('apiUsage.jobApis')}</button>
        <button role="tab" aria-selected={category === 'ai'} data-active={category === 'ai'} onClick={() => { setCategory('ai'); setProvider(''); setSelectedUserId('') }}>{t('apiUsage.modelApis')}</button>
        <label>{t('apiUsage.range')}<select value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>7</option><option value={30}>30</option><option value={90}>90</option></select></label>
        <label>{t('apiUsage.filterProvider')}<select aria-label={t('apiUsage.filterProvider')} value={provider} onChange={event => setProvider(event.target.value)}><option value="">{t('apiUsage.allProviders')}</option>{providerOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
        <small>{t('apiUsage.updated')} {data ? new Date(data.generatedAt).toLocaleTimeString() : '—'} · {t('apiUsage.autoRefresh')}</small>
      </div>
      <section className="admin-metric-grid api-usage-metrics">
        <article className="admin-metric"><span>{t('apiUsage.calls')}</span><strong>{format(summary?.calls ?? 0)}</strong><small>{days} {t('apiUsage.days')}</small></article>
        <article className="admin-metric"><span>{category === 'job' ? t('apiUsage.jobsReturned') : t('apiUsage.tokens')}</span><strong>{format(category === 'job' ? data?.job.summary.jobs ?? 0 : data?.ai.summary.tokens ?? 0)}</strong><small>{category === 'ai' ? `$${(data?.ai.summary.costUsd ?? 0).toFixed(4)}` : t('apiUsage.rawResults')}</small></article>
        <article className="admin-metric"><span>{t('apiUsage.errors')}</span><strong>{format(summary?.errors ?? 0)}</strong><small>{summary?.errorRate ?? 0}%</small></article>
        <article className="admin-metric"><span>{t('apiUsage.providers')}</span><strong>{category === 'job' ? data?.job.providers.length ?? 0 : data?.ai.providers.length ?? 0}</strong><small>{t('apiUsage.ownershipTracked')}</small></article>
      </section>
      <UserUsageSection category={category} users={users} details={details} selectedUserId={selectedUserId} onSelect={setSelectedUserId} t={t} />
      <section className="api-usage-section"><h2>{t('apiUsage.quotas')}</h2><p>{t('apiUsage.quotaHelp')}</p><div className="api-quota-grid">{data?.quotas.filter(quota => quota.category === category).map(quota => <QuotaCard key={quota.id} quota={quota} editable={category === 'job' ? canUpdateJob : canUpdateAi} onSave={saveQuota} t={t} />)}</div></section>
      <section className="api-usage-section"><h2>{t('apiUsage.trend')}</h2><div className="admin-trend-grid">{trends.length ? trends.map(row => <div className="admin-trend-row" key={row.day}><span>{new Date(row.day).toLocaleDateString()}</span><div className="admin-trend-bar"><i style={{ width: `${row.calls / maxTrend * 100}%` }} /></div><strong>{format(row.calls)} {t('apiUsage.callsShort')}</strong></div>) : <p>{t('apiUsage.noData')}</p>}</div></section>
      <section className="api-usage-section"><h2>{t('apiUsage.breakdown')}</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('apiUsage.provider')}</th><th>{t('apiUsage.operationModel')}</th><th>{t('apiUsage.owner')}</th><th>{t('apiUsage.calls')}</th><th>{category === 'job' ? t('apiUsage.jobsReturned') : t('apiUsage.tokens')}</th><th>{t('apiUsage.errors')}</th><th>{t('apiUsage.latency')}</th><th>{t('apiUsage.lastEvent')}</th></tr></thead><tbody>{category === 'job' ? data?.job.providers.map(item => <tr key={item.key}><td>{item.label}</td><td>{item.operations.map(row => row.operation).join(', ') || '—'}{item.maxJobsPerResponse ? ` · ${t('apiUsage.maxJobs')} ${item.maxJobsPerResponse}` : ''}{item.fullJobData ? ` · ${t('apiUsage.fullData')}` : ''}</td><td>{item.operations.map(row => t(`apiUsage.owner.${row.credentialSource}`)).filter((v, i, a) => a.indexOf(v) === i).join(', ') || t(`apiUsage.owner.${item.access === 'public' ? 'public' : 'platform'}`)}</td><td>{format(item.calls)}</td><td>{format(item.jobs)}</td><td>{format(item.errors)}</td><td>{format(item.avgLatency)} ms</td><td>{freshness(item.lastEventAt, t)}</td></tr>) : data?.ai.providers.map(item => <tr key={`${item.provider}-${item.model}-${item.credentialSource}`}><td>{item.provider}</td><td>{item.model}</td><td>{t(`apiUsage.owner.${item.credentialSource}`)}</td><td>{format(item.calls)}</td><td>{format(item.inputTokens + item.outputTokens)}</td><td>{format(item.errors)}</td><td>{format(item.avgLatency)} ms</td><td>{freshness(item.lastEventAt, t)}</td></tr>)}</tbody></table></div></section>
    </main>
  </div>
}

function UserUsageSection({ category, users, details, selectedUserId, onSelect, t }: { category: 'job' | 'ai'; users: UserSummary[]; details: UserDetail[]; selectedUserId: string; onSelect: (value: string) => void; t: (key: string) => string }) {
  return <section className="api-usage-section api-user-usage"><div className="api-usage-section-header"><div><h2>{t('apiUsage.users')}</h2><p>{t('apiUsage.userHelp')}</p></div><label>{t('apiUsage.selectUser')}<select value={selectedUserId} onChange={event => onSelect(event.target.value)}><option value="">{t('apiUsage.allUsers')}</option>{users.map(user => <option key={user.userId} value={user.userId}>{user.userId}</option>)}</select></label></div>
    <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('apiUsage.userId')}</th><th>{t('apiUsage.calls')}</th><th>{category === 'job' ? t('apiUsage.jobsReturned') : t('apiUsage.tokens')}</th><th>{t('apiUsage.cost')}</th><th>{t('apiUsage.errors')}</th><th>{t('apiUsage.lastEvent')}</th></tr></thead><tbody>{users.length ? users.map(user => <tr key={user.userId} data-selected={selectedUserId === user.userId}><td><button className="admin-row-action" type="button" onClick={() => onSelect(user.userId)}>{user.userId}</button></td><td>{format(user.calls)}</td><td>{format(category === 'job' ? user.jobs : user.tokens)}</td><td>{category === 'ai' ? `$${user.cost.toFixed(6)}` : '—'}</td><td>{format(user.errors)}</td><td>{freshness(user.lastEventAt, t)}</td></tr>) : <tr><td colSpan={6}>{t('apiUsage.noUserData')}</td></tr>}</tbody></table></div>
    {selectedUserId && <><h3 className="api-user-detail-title">{t('apiUsage.userDetail')} · {selectedUserId}</h3><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('apiUsage.provider')}</th><th>{t('apiUsage.operationModel')}</th><th>{t('apiUsage.feature')}</th><th>{t('apiUsage.runtime')}</th><th>{t('apiUsage.owner')}</th><th>{t('apiUsage.calls')}</th><th>{category === 'job' ? t('apiUsage.jobsReturned') : t('apiUsage.tokens')}</th><th>{t('apiUsage.errors')}</th><th>{t('apiUsage.latency')}</th></tr></thead><tbody>{details.length ? details.map((row, index) => <tr key={`${row.provider}-${row.operationModel}-${row.runtime}-${index}`}><td>{row.provider}</td><td>{row.operationModel}</td><td>{row.featureKey || '—'}</td><td>{t(`apiUsage.runtime.${row.runtime}`)}</td><td>{t(`apiUsage.owner.${row.credentialSource}`)}</td><td>{format(row.calls)}</td><td>{format(category === 'job' ? row.jobs : row.tokens)}</td><td>{format(row.errors)}</td><td>{format(row.avgLatency)} ms</td></tr>) : <tr><td colSpan={9}>{t('apiUsage.noUserData')}</td></tr>}</tbody></table></div></>}
  </section>
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
