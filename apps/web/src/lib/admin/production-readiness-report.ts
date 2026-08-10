import type { DeploymentReadiness } from './deployment-readiness'

export function readinessFailures(readiness: DeploymentReadiness): string[] {
  const failures: string[] = []
  if (readiness.candidateSettings.migrations.state !== 'ready') failures.push('migrations')
  if (readiness.candidateSettings.superAdminPermission !== 'ready') failures.push('super_admin_permission')
  if (readiness.candidateSettings.currentActorPermission !== 'ready') failures.push('current_admin_permission')
  if (readiness.infrastructure?.database !== 'ready') failures.push('database')
  if (readiness.infrastructure?.redis !== 'ready') failures.push('redis')
  if (readiness.workerControl.state !== 'ready') failures.push('worker_control')
  if (readiness.security?.webauthn.state !== 'ready') failures.push('webauthn_config')
  if (readiness.security?.rls.state !== 'ready') failures.push('rls')
  if (readiness.security?.audit.state !== 'ready') failures.push('audit_chain')
  return failures
}
