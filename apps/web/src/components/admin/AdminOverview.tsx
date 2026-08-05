'use client'

import { AlertTriangle, CalendarDays, ShieldCheck } from 'lucide-react'
import { useApi } from '@/lib/hooks'

type Metrics = { overall: { total: number; successRate: number; avgDurationMs: number; captchaRate: number; last24h: { count: number; successRate: number } }; platform: { registeredUsers: number; registrationsLast7d: number; plans: Record<string, number>; sources: { employers: number; jobs: number }; overdueSupportCases: number } }
type QueueData = { queues: { counts: Record<string, number> }[] }

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <section className="admin-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></section>
}

export function AdminOverview() {
  const { data, loading, error } = useApi<Metrics>('/api/admin/v1/observability')
  const queueSummary = useApi<QueueData>('/api/admin/v1/queues')
  const metrics = data?.overall
  const platform = data?.platform
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
        <Metric label="Queue workload" value={queueSummary.loading ? '...' : String(queued)} detail={queueSummary.error ? 'Control plane unavailable' : 'Waiting and active jobs'} />
        <Metric label="Overdue support" value={loading ? '...' : String(platform?.overdueSupportCases ?? 0)} detail="Cases beyond SLA" />
      </div>
      <section className="admin-status-panel"><ShieldCheck size={19} /><div><strong>Privacy controls active</strong><p>{planSummary}. Operational screens use allow-listed metadata only. Secrets, documents, and mailbox content are excluded.</p></div></section>
    </div>
  </div>
}
