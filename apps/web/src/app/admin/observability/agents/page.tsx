import React from 'react'
import { redirect } from 'next/navigation'
import { getHarnessDashboardSnapshot } from '@/lib/observability/admin-dashboard'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export const dynamic = 'force-dynamic'

export default async function HarnessAgentsObservabilityPage() {
  const actor = await requireAdmin('observability.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/observability/agents')
  const snapshot = await getHarnessDashboardSnapshot('agents')
  return <main className="admin-page">
    <header className="admin-header"><div><h1>Harness agent observability</h1><p>Session, turn, tool and failure aggregates for the last 24 hours.</p></div></header>
    {!snapshot.available && <div className="admin-alert">Harness observability storage is not available. Apply the additive database migration before relying on these metrics.</div>}
    <section className="admin-list-page">
      <div className="admin-metric-grid">
        <article className="admin-metric"><span>Sessions started</span><strong>{snapshot.startedSessions ?? '—'}</strong></article>
        <article className="admin-metric"><span>Sessions completed</span><strong>{snapshot.completedSessions ?? '—'}</strong></article>
        <article className="admin-metric"><span>Active turns</span><strong>{snapshot.activeTurns ?? '—'}</strong></article>
        <article className="admin-metric"><span>Failed events</span><strong>{snapshot.failedEventCount ?? '—'}</strong></article>
      </div>
      {snapshot.openAlerts.length > 0 && <div className="admin-alert">Open SLO alerts: {snapshot.openAlerts.map(alert => `${alert.ruleKey} (${alert.value} > ${alert.threshold})`).join(', ')}</div>}
    </section>
  </main>
}
