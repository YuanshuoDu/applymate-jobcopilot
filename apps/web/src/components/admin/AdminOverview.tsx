'use client'

import { AlertTriangle, CalendarDays, ShieldCheck } from 'lucide-react'
import { useApi } from '@/lib/hooks'
import type { PlatformIntegrationStatus } from '@/lib/admin/integration-status'

type Metrics = { overall: { total: number; successRate: number; avgDurationMs: number; captchaRate: number; last24h: { count: number; successRate: number } }; platform: { registeredUsers: number; registrationsLast7d: number; plans: Record<string, number>; sources: { employers: number; jobs: number }; overdueSupportCases: number } }
type QueueData = { queues: { counts: Record<string, number> }[] }
type PlatformData = { integrations: PlatformIntegrationStatus }
type AdminOverviewProps = { permissions: readonly string[] }

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <section className="admin-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></section>
}

export function AdminOverview({ permissions }: AdminOverviewProps) {
  const { data, loading, error } = useApi<Metrics>('/api/admin/v1/observability')
  const canReadQueues = permissions.includes('queues.read')
  const queueSummary = useApi<QueueData>('/api/admin/v1/queues', { enabled: canReadQueues })
  const platformSummary = useApi<PlatformData>('/api/admin/v1/platform', { cache: false })
  const metrics = data?.overall
  const platform = data?.platform
  const integrations = platformSummary.data?.integrations
  const integrationChecks = integrations ? [
    ['MiniMax', integrations.ai.providers.minimax],
    ['Adzuna', integrations.discovery.adzuna],
    ['RapidAPI', integrations.discovery.rapidapi],
    ['Google OAuth', integrations.oauth.google],
    ['GitHub OAuth', integrations.oauth.github],
    ['Resend', integrations.messaging.resend],
    ['Database', integrations.infrastructure.database],
    ['Redis', integrations.infrastructure.redis],
  ] as const : []
  const readyIntegrations = integrationChecks.filter(([, ready]) => ready).length
  const queued = queueSummary.data?.queues.reduce((sum, queue) => sum + (queue.counts.waiting ?? 0) + (queue.counts.active ?? 0), 0) ?? 0
  const planSummary = platform ? Object.entries(platform.plans).map(([plan, count]) => `${plan}: ${count}`).join(' · ') || 'No accounts' : 'Loading plan mix'
  return <div className="admin-page">
    <header className="admin-header"><div><h1>Platform overview</h1><p>Operational health and alerts</p></div><div className="admin-header-time"><CalendarDays size={18} /> Internal console</div></header>
    <div className="admin-overview">
      {error && <div className="admin-alert"><AlertTriangle size={18} />Unable to load platform metrics.</div>}
      <div className="admin-metric-grid admin-metric-grid-wide">
        <Metric label="Applications" value={loading ? '...' : String(metrics?.total ?? 0)} detail="All time" />
        <Metric label="Registered users" value={loading ? '...' : String(platform?.registeredUsers ?? 0)} detail={`${platform?.registrationsLast7d ?? 0} in last 7 days`} />
        <Metric label="Success rate" value={loading ? '...' : `${metrics?.successRate ?? 0}%`} detail="Submitted applications" />
        <Metric label="Last 24 hours" value={loading ? '...' : String(metrics?.last24h.count ?? 0)} detail={`${metrics?.last24h.successRate ?? 0}% success`} />
        <Metric label="CAPTCHA rate" value={loading ? '...' : `${metrics?.captchaRate ?? 0}%`} detail="Across auto-apply runs" />
        <Metric label="Discovery sources" value={loading ? '...' : String(platform?.sources.employers ?? 0)} detail={`${platform?.sources.jobs ?? 0} indexed jobs`} />
        <Metric label="Queue workload" value={!canReadQueues ? '—' : queueSummary.loading ? '...' : String(queued)} detail={!canReadQueues ? 'Not available for this role' : queueSummary.error ? 'Control plane unavailable' : 'Waiting and active jobs'} />
        <Metric label="Overdue support" value={loading ? '...' : String(platform?.overdueSupportCases ?? 0)} detail="Cases beyond SLA" />
      </div>
      <section className="admin-status-panel"><ShieldCheck size={19} /><div><strong>Privacy controls active</strong><p>{planSummary}. Operational screens use allow-listed metadata only. Secrets, documents, and mailbox content are excluded.</p></div></section>
      <section className="admin-status-panel admin-integration-panel" aria-label="Platform integrations"><div><strong>Platform integrations</strong><p>{platformSummary.error ? 'Integration status unavailable.' : platformSummary.loading && !integrations ? 'Loading integration status...' : `${readyIntegrations}/${integrationChecks.length} ready`}</p>{integrationChecks.length > 0 && <div className="admin-integration-grid">{integrationChecks.map(([label, ready]) => <span key={label} className="admin-integration-chip" data-ready={ready}>{label}: {ready ? 'Ready' : 'Missing'}</span>)}</div>}</div></section>
    </div>
  </div>
}
