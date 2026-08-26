'use client'

import { AdminDataTable, values, type BulkAction } from './AdminDataTable'
import { AdminAtsControls } from './AdminAtsControls'
import { AdminAtsQualityTrends } from './AdminAtsQualityTrends'
import { AdminBudgetControls } from './AdminBudgetControls'
import { AdminAiConfigPanel } from './AdminAiConfigPanel'
import { AdminAiUsageTrends } from './AdminAiUsageTrends'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import Link from 'next/link'
import { useI18n } from '@/lib/i18n'

function ApplicationActions({ row, permissions }: { row: Record<string, unknown>; permissions: readonly string[] }) {
  const { t } = useI18n()
  const { request, dialog } = useAdminPrompt()
  const taskId = typeof row.taskId === 'string' ? row.taskId : null
  if (!taskId) return <span>-</span>
  async function act(action: 'retry' | 'cancel' | 'manual_review') {
    const reason = await request({ title: t('ops.confirmApplicationAction'), label: t('ops.operationalReason'), kind: 'reason', description: t('ops.auditReasonDescription'), submitLabel: t('ops.continue') })
    if (!reason) return
    const response = await fetch(`/api/admin/v1/applications/${taskId}/action`, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ action, reason }) })
    if (response.ok) window.location.reload()
  }
  const status = String(row.taskStatus ?? '')
  return <><span className="admin-action-group">{permissions.includes('applications.retry') && ['failed', 'cancelled'].includes(status) && <button className="admin-row-action" title={t('ops.retryApplication')} onClick={() => void act('retry')}>{t('ops.retry')}</button>}{permissions.includes('applications.manual_review') && !['submitted', 'cancelled'].includes(status) && <button className="admin-row-action" title={t('ops.manualReview')} onClick={() => void act('manual_review')}>{t('ops.review')}</button>}{permissions.includes('applications.cancel') && !['submitted', 'skipped', 'cancelled'].includes(status) && <button className="admin-row-action" title={t('ops.cancelApplication')} onClick={() => void act('cancel')}>{t('ops.cancel')}</button>}</span>{dialog}</>
}

export function AdminUsersPage({ canExport = false, permissions = [] }: { canExport?: boolean; permissions?: readonly string[] }) {
  const { t } = useI18n()
  const { request, dialog } = useAdminPrompt()
  async function runBulk(action: 'suspend' | 'restore', ids: string[]) {
    const reason = await request({ title: action === 'suspend' ? t('ops.suspendAccounts') : t('ops.restoreAccounts'), label: t('ops.operationalReason'), kind: 'reason', submitLabel: t('ops.continue') })
    if (!reason) return
    const response = await fetch('/api/admin/v1/bulk', { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ resource: 'users', action, ids, reason }) })
    if (response.ok) window.location.reload()
  }
  const bulkActions: BulkAction[] = [
    ...(permissions.includes('users.suspend') ? [{ label: t('ops.suspendSelected'), onRun: (ids: string[]) => runBulk('suspend', ids) }] : []),
    ...(permissions.includes('users.restore') ? [{ label: t('ops.restoreSelected'), onRun: (ids: string[]) => runBulk('restore', ids) }] : []),
  ]
  return <><div className="admin-list-toolbar"><span>{t('ops.exportNotice')}</span></div><AdminDataTable title={t('ops.usersTitle')} subtitle={t('ops.usersSubtitle')} endpoint="/api/admin/v1/users" searchable searchLabel={t('ops.searchUsers')} searchPlaceholder={t('ops.searchNameEmail')} columns={[
    { label: t('ops.user'), value: (row) => <Link prefetch={false} className="admin-table-link" href={`/admin/users/${row.id}`}>{String(row.name ?? 'Unnamed')} · {String(row.email ?? '')}</Link> }, { label: t('ops.plan'), value: values.text('plan') },
    { label: t('ops.status'), sortKey: 'accountStatus', value: values.text('accountStatus') }, { label: t('ops.location'), value: values.text('location') }, { label: t('ops.jobs'), sortKey: 'jobsCount', value: values.text('jobsCount') }, { label: t('ops.resume'), value: (row) => row.resumeExists ? t('ops.onFile') : t('ops.notUploaded') }, { label: t('ops.joined'), sortKey: 'createdAt', value: values.date('createdAt') },
  ]} filters={[{ label: t('ops.plan'), param: 'plan', options: [{ label: t('ops.free'), value: 'free' }, { label: t('ops.pro'), value: 'pro' }, { label: t('ops.enterprise'), value: 'enterprise' }] }, { label: t('ops.status'), param: 'status', options: [{ label: t('ops.active'), value: 'active' }, { label: t('ops.suspended'), value: 'suspended' }] }]} exportEndpoint={canExport ? '/api/admin/v1/export?resource=users' : undefined} bulkActions={bulkActions} />{dialog}</>
}

export function AdminAtsPage({ permissions }: { permissions: readonly string[] }) {
  const { t } = useI18n()
  return <><AdminDataTable title={t('ops.atsTitle')} subtitle={t('ops.atsSubtitle')} endpoint="/api/admin/v1/ats" columns={[
    { label: t('ops.source'), sortKey: 'name', value: (row) => `${row.atsType} · ${row.name ?? row.slug}` }, { label: t('ops.jobs'), sortKey: 'jobCount', value: values.text('jobCount') },
    { label: t('ops.rpsCeiling'), value: (row) => row.rateLimitRps ? `${row.rateLimitRps} rps` : t('ops.notRegistered') }, { label: t('ops.lastSeen'), sortKey: 'lastSeen', value: values.date('lastSeen') }, { label: t('ops.credential'), value: (row) => row.credentialRequirement === 'none' ? t('ops.notRequired') : row.credentialConfigured ? t('ops.configured') : t('ops.notReported') },
  ]} exportEndpoint="/api/admin/v1/export?resource=ats" /><AdminAtsControls permissions={permissions} /><AdminAtsQualityTrends /></>
}

export function AdminApplicationsPage({ permissions = [] }: { permissions?: readonly string[] }) {
  const { t } = useI18n()
  const { request, dialog } = useAdminPrompt()
  async function runBulk(action: 'cancel' | 'manual_review', ids: string[]) {
    const reason = await request({ title: action === 'cancel' ? t('ops.cancelSelected') : t('ops.reviewSelected'), label: t('ops.operationalReason'), kind: 'reason', submitLabel: t('ops.continue') })
    if (!reason) return
    const response = await fetch('/api/admin/v1/bulk', { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ resource: 'applications', action, ids, reason }) })
    if (response.ok) window.location.reload()
  }
  const bulkActions: BulkAction[] = [
    ...(permissions.includes('applications.cancel') ? [{ label: t('ops.cancelSelected'), onRun: (ids: string[]) => runBulk('cancel', ids) }] : []),
    ...(permissions.includes('applications.manual_review') ? [{ label: t('ops.reviewSelected'), onRun: (ids: string[]) => runBulk('manual_review', ids) }] : []),
  ]
  return <><AdminDataTable title={t('ops.applicationsTitle')} subtitle={t('ops.applicationsSubtitle')} endpoint="/api/admin/v1/applications" columns={[
    { label: t('ops.id'), sortKey: 'createdAt', value: row => <Link prefetch={false} className="admin-table-link" href={`/admin/applications/${row.id}`}>{String(row.id)}</Link> }, { label: t('ops.status'), sortKey: 'status', value: values.text('status') }, { label: t('ops.ats'), value: values.text('atsType') }, { label: t('ops.flow'), value: values.text('flowUsed') },
    { label: t('ops.mode'), value: values.text('mode') }, { label: t('ops.errorClass'), value: values.text('errorClass') }, { label: t('ops.duration'), sortKey: 'durationMs', value: values.duration('durationMs') }, { label: t('ops.created'), sortKey: 'createdAt', value: values.date('createdAt') }, { label: t('ops.task'), value: values.text('taskStatus') }, { label: t('ops.actions'), value: row => <ApplicationActions row={row} permissions={permissions} /> },
  ]} filters={[{ label: t('ops.status'), param: 'status', options: [{ label: t('ops.submitted'), value: 'submitted' }, { label: t('ops.failed'), value: 'failed' }, { label: t('ops.manual'), value: 'manual' }] }, { label: t('ops.mode'), param: 'mode', options: [{ label: t('ops.unattended'), value: 'unattended' }, { label: t('ops.assisted'), value: 'assisted' }] }]} exportEndpoint="/api/admin/v1/export?resource=applications" bulkActions={bulkActions} />{dialog}</>
}

export function AdminAiPage({ permissions }: { permissions: readonly string[] }) {
  const { t } = useI18n()
  return <><AdminDataTable title={t('ops.aiTitle')} subtitle={t('ops.aiSubtitle')} endpoint="/api/admin/v1/ai/budgets" columns={[
    { label: t('ops.userId'), value: values.text('userId') }, { label: t('ops.month'), value: values.text('month') }, { label: t('ops.used'), sortKey: 'used', value: values.text('used') },
    { label: t('ops.limit'), sortKey: 'limit', value: values.text('limit') }, { label: t('ops.remaining'), value: values.text('remaining') }, { label: t('ops.updated'), sortKey: 'updatedAt', value: values.date('updatedAt') },
  ]} exportEndpoint="/api/admin/v1/export?resource=ai-budgets" emptyMessage={t('ops.aiEmpty')} /><AdminBudgetControls canUpdate={permissions.includes('ai_budget.update')} /><AdminAiConfigPanel canUpdate={permissions.includes('ai_budget.update')} /><AdminAiUsageTrends /></>
}

export function AdminAuditPage() {
  const { t } = useI18n()
  return <AdminDataTable title={t('ops.auditTitle')} subtitle={t('ops.auditSubtitle')} endpoint="/api/admin/v1/audit" columns={[
    { label: t('ops.action'), sortKey: 'action', value: values.text('action') }, { label: t('ops.outcome'), sortKey: 'outcome', value: values.text('outcome') }, { label: t('ops.role'), value: values.text('actorRoleKey') },
    { label: t('ops.target'), value: (row) => row.targetType ? `${row.targetType} · ${row.targetId ?? '-'}` : '-' }, { label: t('ops.errorCode'), value: values.text('errorCode') }, { label: t('ops.time'), sortKey: 'createdAt', value: values.date('createdAt') },
  ]} exportEndpoint="/api/admin/v1/export?resource=audit" />
}
