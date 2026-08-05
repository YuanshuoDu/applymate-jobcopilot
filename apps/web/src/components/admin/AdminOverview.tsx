'use client'

import { AlertTriangle, CalendarDays, ShieldCheck } from 'lucide-react'
import { useApi } from '@/lib/hooks'

type Metrics = { overall: { total: number; successRate: number; avgDurationMs: number; captchaRate: number; last24h: { count: number; successRate: number } } }

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <section className="admin-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></section>
}

export function AdminOverview() {
  const { data, loading, error } = useApi<Metrics>('/api/admin/v1/observability')
  const metrics = data?.overall
  return <div className="admin-page">
    <header className="admin-header"><div><h1>Platform overview</h1><p>Operational health and alerts</p></div><div className="admin-header-time"><CalendarDays size={18} /> Internal console</div></header>
    <div className="admin-overview">
      {error && <div className="admin-alert"><AlertTriangle size={18} />Unable to load platform metrics.</div>}
      <div className="admin-metric-grid">
        <Metric label="Applications" value={loading ? '...' : String(metrics?.total ?? 0)} detail="All time" />
        <Metric label="Success rate" value={loading ? '...' : `${metrics?.successRate ?? 0}%`} detail="Submitted applications" />
        <Metric label="Last 24 hours" value={loading ? '...' : String(metrics?.last24h.count ?? 0)} detail={`${metrics?.last24h.successRate ?? 0}% success`} />
        <Metric label="CAPTCHA rate" value={loading ? '...' : `${metrics?.captchaRate ?? 0}%`} detail="Across auto-apply runs" />
      </div>
      <section className="admin-status-panel"><ShieldCheck size={19} /><div><strong>Privacy controls active</strong><p>Operational screens use allow-listed metadata only. Secrets, documents, and mailbox content are excluded.</p></div></section>
    </div>
  </div>
}
