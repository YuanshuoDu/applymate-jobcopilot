'use client'

import React from 'react'
import type { DeploymentReadiness, ReadinessState } from '@/lib/admin/deployment-readiness'
import { useI18n } from '@/lib/i18n'

function statusLabel(status: 'ready' | 'missing' | 'unavailable', t: (key: string) => string) {
  return t(`deploymentReadiness.${status}`)
}

function joinNeeds(needs: string[], t: (key: string) => string) {
  if (needs.length < 2) return needs[0]
  return `${needs.slice(0, -1).join(', ')} ${t('deploymentReadiness.and')} ${needs.at(-1)}`
}

export function DeploymentReadinessPanel({ readiness }: { readiness?: DeploymentReadiness }) {
  const { t } = useI18n()
  if (!readiness) return null

  const migrationState = readiness.candidateSettings.migrations.state
  const checks: Array<readonly [string, ReadinessState]> = [
    [t('deploymentReadiness.settingsMigrations'), migrationState],
    [t('deploymentReadiness.superAdmin'), readiness.candidateSettings.superAdminPermission],
    [t('deploymentReadiness.currentAdmin'), readiness.candidateSettings.currentActorPermission],
    [t('deploymentReadiness.workerControl'), readiness.workerControl.state],
  ]
  if (readiness.infrastructure) {
    checks.push([t('deploymentReadiness.database'), readiness.infrastructure.database], [t('deploymentReadiness.redis'), readiness.infrastructure.redis])
  }
  if (readiness.security) {
    checks.push(
      [t('deploymentReadiness.rls'), readiness.security.rls.state],
      [t('deploymentReadiness.webAuthn'), readiness.security.webauthn.state],
      [t('deploymentReadiness.auditChain'), readiness.security.audit.state],
    )
  }
  const workerNeeds = [
    !readiness.workerControl.urlConfigured ? t('deploymentReadiness.url') : null,
    !readiness.workerControl.secretConfigured ? t('deploymentReadiness.sharedSecret') : null,
  ].filter((value): value is string => value !== null)

  return <section className="admin-status-panel admin-integration-panel" aria-label={t('deploymentReadiness.title')}>
    <div>
      <strong>{t('deploymentReadiness.title')}</strong>
      <p>{t('deploymentReadiness.description')}</p>
      <div className="admin-integration-grid">
        {checks.map(([label, state]) => <span key={label} className="admin-integration-chip" data-ready={state === 'ready'}>{label}: {statusLabel(state, t)}</span>)}
      </div>
      {migrationState === 'missing' && <p>{t('deploymentReadiness.pendingMigrations')}: {readiness.candidateSettings.migrations.missing.join(', ')}</p>}
      {migrationState === 'unavailable' && <p>{t('deploymentReadiness.databaseChecksUnavailable')}</p>}
      {workerNeeds.length > 0 && <p>{t('deploymentReadiness.workerNeeds')}: {joinNeeds(workerNeeds, t)}</p>}
      {readiness.workerControl.state === 'unavailable' && <p>{t('deploymentReadiness.workerProbeFailed')}</p>}
      {readiness.infrastructure?.database === 'unavailable' && <p>{t('deploymentReadiness.databaseProbeFailed')}</p>}
      {readiness.infrastructure?.redis === 'unavailable' && <p>{t('deploymentReadiness.redisProbeFailed')}</p>}
      {readiness.security?.rls.state === 'missing' && <p>{t('deploymentReadiness.rlsMissing')}</p>}
      {readiness.security?.audit.state === 'missing' && <p>{t('deploymentReadiness.auditMissing')}</p>}
    </div>
  </section>
}
