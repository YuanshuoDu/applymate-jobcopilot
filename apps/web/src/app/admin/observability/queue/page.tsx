import React from 'react'
import { redirect } from 'next/navigation'
import { getHarnessDashboardSnapshot } from '@/lib/observability/admin-dashboard'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export const dynamic = 'force-dynamic'

export default async function HarnessQueueObservabilityPage() {
  const actor = await requireAdmin('observability.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/observability/queue')
  const snapshot = await getHarnessDashboardSnapshot('queue')
  return <main className="admin-page">
    <header className="admin-header"><div><h1>Harness queue observability</h1><p>Queue depth and event health for the last 24 hours. Data is server-side and read-only.</p></div></header>
    {!snapshot.available && <div className="admin-alert">Harness observability storage is not available. Apply the additive database migration before relying on these metrics.</div>}
    <section className="admin-list-page">
      <div className="admin-metric-grid">
        <article className="admin-metric"><span>Latest queue depth</span><strong>{snapshot.latestQueueDepth ?? '—'}</strong></article>
        <article className="admin-metric"><span>Events in window</span><strong>{snapshot.eventCount ?? '—'}</strong></article>
        <article className="admin-metric"><span>Failed events</span><strong>{snapshot.failedEventCount ?? '—'}</strong></article>
      </div>
      <p>Latest event: {snapshot.latestEventAt ? new Date(snapshot.latestEventAt).toLocaleString() : '—'}</p>
      {snapshot.openAlerts.length > 0 && <div className="admin-alert">Open SLO alerts: {snapshot.openAlerts.map(alert => `${alert.ruleKey} (${alert.value} > ${alert.threshold})`).join(', ')}</div>}
    </section>
  </main>
}
