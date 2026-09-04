import React from 'react'
import { redirect } from 'next/navigation'
import { getHarnessDashboardSnapshot } from '@/lib/observability/admin-dashboard'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export const dynamic = 'force-dynamic'

export default async function HarnessUsageObservabilityPage() {
  const actor = await requireAdmin('observability.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/observability/usage')
  const snapshot = await getHarnessDashboardSnapshot('usage')
  return <main className="admin-page">
    <header className="admin-header"><div><h1>Harness usage observability</h1><p>Five-minute usage rollups grouped by model and tool. No prompts, email addresses or provider payloads are exposed.</p></div></header>
    {!snapshot.available && <div className="admin-alert">Harness observability storage is not available. Apply the additive database migration before relying on these metrics.</div>}
    <section className="admin-list-page">
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Model</th><th>Tool</th><th>Events</th><th>Input tokens</th><th>Output tokens</th><th>Estimated cost (USD)</th></tr></thead><tbody>
        {snapshot.usage.length === 0 ? <tr><td colSpan={6}>No usage rollups in the last 24 hours.</td></tr> : snapshot.usage.map(row => <tr key={`${row.model}:${row.toolName}`}><td>{row.model}</td><td>{row.toolName}</td><td>{row.eventCount}</td><td>{row.inputTokens}</td><td>{row.outputTokens}</td><td>{row.estimatedCostUsd.toFixed(6)}</td></tr>)}
      </tbody></table></div>
      {snapshot.openAlerts.length > 0 && <div className="admin-alert">Open SLO alerts: {snapshot.openAlerts.map(alert => `${alert.ruleKey} (${alert.value} > ${alert.threshold})`).join(', ')}</div>}
    </section>
  </main>
}
