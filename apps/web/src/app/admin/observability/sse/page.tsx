import React from 'react'
import { redirect } from 'next/navigation'
import { getHarnessDashboardSnapshot } from '@/lib/observability/admin-dashboard'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export const dynamic = 'force-dynamic'

export default async function HarnessSseObservabilityPage() {
  const actor = await requireAdmin('observability.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/observability/sse')
  const snapshot = await getHarnessDashboardSnapshot('sse')
  return <main className="admin-page">
    <header className="admin-header"><div><h1>Harness SSE observability</h1><p>Server event trail health and replay signals. Raw event payloads are never rendered here.</p></div></header>
    {!snapshot.available && <div className="admin-alert">Harness observability storage is not available. Apply the additive database migration before relying on these metrics.</div>}
    <section className="admin-list-page">
      <div className="admin-metric-grid">
        <article className="admin-metric"><span>Events in window</span><strong>{snapshot.eventCount ?? '—'}</strong></article>
        <article className="admin-metric"><span>Latest event</span><strong>{snapshot.latestEventAt ? new Date(snapshot.latestEventAt).toLocaleTimeString() : '—'}</strong></article>
        <article className="admin-metric"><span>Failed events</span><strong>{snapshot.failedEventCount ?? '—'}</strong></article>
        <article className="admin-metric"><span>Completed sessions</span><strong>{snapshot.completedSessions ?? '—'}</strong></article>
      </div>
      <p>The page reads the same persisted trace facts used by replay and live synchronization; it does not open a client-side stream.</p>
      {snapshot.openAlerts.length > 0 && <div className="admin-alert">Open SLO alerts: {snapshot.openAlerts.map(alert => `${alert.ruleKey} (${alert.value} > ${alert.threshold})`).join(', ')}</div>}
    </section>
  </main>
}
