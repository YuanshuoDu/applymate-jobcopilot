import React from 'react'
import type { DeploymentReadiness } from '@/lib/admin/deployment-readiness'

function statusLabel(status: 'ready' | 'missing' | 'unavailable') {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function joinNeeds(needs: string[]) {
  if (needs.length < 2) return needs[0]
  return `${needs.slice(0, -1).join(', ')} and ${needs.at(-1)}`
}

export function DeploymentReadinessPanel({ readiness }: { readiness?: DeploymentReadiness }) {
  if (!readiness) return null

  const migrationState = readiness.candidateSettings.migrations.state
  const checks = [
    ['Settings migrations', migrationState],
    ['Super admin', readiness.candidateSettings.superAdminPermission],
    ['Current admin', readiness.candidateSettings.currentActorPermission],
    ['Worker control', readiness.workerControl.state],
  ] as const
  const workerNeeds = [
    !readiness.workerControl.urlConfigured ? 'URL' : null,
    !readiness.workerControl.secretConfigured ? 'shared secret' : null,
  ].filter((value): value is string => value !== null)

  return <section className="admin-status-panel admin-integration-panel" aria-label="Deployment readiness">
    <div>
      <strong>Deployment readiness</strong>
      <p>Checks deployment prerequisites without exposing credentials or user data.</p>
      <div className="admin-integration-grid">
        {checks.map(([label, state]) => <span key={label} className="admin-integration-chip" data-ready={state === 'ready'}>{label}: {statusLabel(state)}</span>)}
      </div>
      {migrationState === 'missing' && <p>Pending migrations: {readiness.candidateSettings.migrations.missing.join(', ')}</p>}
      {migrationState === 'unavailable' && <p>Database readiness checks are unavailable.</p>}
      {workerNeeds.length > 0 && <p>Worker controls need: {joinNeeds(workerNeeds)}</p>}
    </div>
  </section>
}
