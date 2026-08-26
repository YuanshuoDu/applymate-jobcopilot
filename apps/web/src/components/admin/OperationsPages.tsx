'use client'

import { AdminDataTable, values, type BulkAction, type TableControls } from './AdminDataTable'
import { AdminAtsControls } from './AdminAtsControls'
import { AdminAtsQualityTrends } from './AdminAtsQualityTrends'
import { AdminBudgetControls } from './AdminBudgetControls'
import { AdminAiConfigPanel } from './AdminAiConfigPanel'
import { AdminAiUsageTrends } from './AdminAiUsageTrends'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import Link from 'next/link'
import { useState } from 'react'
import { useI18n } from '@/lib/i18n'

const APPLICATION_STATUSES = ['discovered', 'analyzing', 'generating_materials', 'filling', 'waiting_for_user', 'waiting_for_authorization', 'submitted', 'skipped', 'failed', 'cancelled'] as const

function ApplicationStatus({ value }: { value: unknown }) {
  const { t } = useI18n()
  const status = APPLICATION_STATUSES.includes(String(value) as typeof APPLICATION_STATUSES[number]) ? String(value) : 'unknown'
  return <span className="admin-application-state"><strong className="admin-status-badge" data-status={status}>{t(`applications.status.${status}`)}</strong></span>
}

function ApplicationActions({ row, permissions, controls, onNotice }: { row: Record<string, unknown>; permissions: readonly string[]; controls: TableControls; onNotice: (message: string) => void }) {
  const { t } = useI18n()
  const { request, dialog } = useAdminPrompt()
  const [busy, setBusy] = useState(false)
  const taskId = typeof row.id === 'string' ? row.id : null
  if (!taskId) return <span>-</span>
  async function act(action: 'retry' | 'cancel' | 'manual_review') {
    const reason = await request({ title: t('ops.confirmApplicationAction'), label: t('ops.operationalReason'), kind: 'reason', description: t('ops.auditReasonDescription'), submitLabel: t('ops.continue') })
    if (!reason) return
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/v1/applications/${taskId}/action`, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ action, reason }) })
      const payload = await response.json().catch(() => null) as { error?: string } | null
      onNotice(response.ok ? t('applications.actionSucceeded') : payload?.error ?? t('applications.actionFailed'))
      if (response.ok) await controls.refresh()
    } catch {
      onNotice(t('applications.actionFailed'))
    } finally {
      setBusy(false)
    }
  }
  const status = String(row.status ?? '')
  return <><span className="admin-action-group">{permissions.includes('applications.retry') && ['failed', 'cancelled'].includes(status) && <button className="admin-row-action" disabled={busy} title={t('ops.retryApplication')} onClick={() => void act('retry')}>{t('ops.retry')}</button>}{permissions.includes('applications.manual_review') && !['submitted', 'cancelled'].includes(status) && <button className="admin-row-action" disabled={busy} title={t('ops.manualReview')} onClick={() => void act('manual_review')}>{t('ops.review')}</button>}{permissions.includes('applications.cancel') && !['submitted', 'skipped', 'cancelled'].includes(status) && <button className="admin-row-action" disabled={busy} title={t('ops.cancelApplication')} onClick={() => void act('cancel')}>{t('ops.cancel')}</button>}</span>{dialog}</>
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
  const [notice, setNotice] = useState('')
  async function runBulk(action: 'cancel' | 'manual_review', ids: string[]) {
    const reason = await request({ title: action === 'cancel' ? t('ops.cancelSelected') : t('ops.reviewSelected'), label: t('ops.operationalReason'), kind: 'reason', submitLabel: t('ops.continue') })
    if (!reason) return
    try {
      const response = await fetch('/api/admin/v1/bulk', { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ resource: 'applications', action, ids, reason }) })
      const payload = await response.json().catch(() => null) as { affected?: number; error?: string } | null
      setNotice(response.ok ? t('applications.bulkSucceeded').replace('{count}', String(payload?.affected ?? 0)) : payload?.error ?? t('applications.actionFailed'))
    } catch {
      setNotice(t('applications.actionFailed'))
    }
  }
  const bulkActions: BulkAction[] = [
    ...(permissions.includes('applications.cancel') ? [{ label: t('ops.cancelSelected'), onRun: (ids: string[]) => runBulk('cancel', ids) }] : []),
    ...(permissions.includes('applications.manual_review') ? [{ label: t('ops.reviewSelected'), onRun: (ids: string[]) => runBulk('manual_review', ids) }] : []),
  ]
  return <><AdminDataTable title={t('ops.applicationsTitle')} subtitle={t('applications.subtitle')} endpoint="/api/admin/v1/applications" searchable searchLabel={t('applications.search')} searchPlaceholder={t('applications.searchPlaceholder')} statusMessage={notice} defaultSort="updatedAt" defaultDirection="desc" columns={[
    { label: t('applications.application'), value: row => <span className="admin-application-primary"><Link prefetch={false} className="admin-table-link" href={`/admin/applications/${row.id}`}>{String(row.role)} · {String(row.company)}</Link><small title={String(row.id)}>{String(row.id)}</small></span> },
    { label: t('applications.lifecycle'), sortKey: 'status', value: row => <span className="admin-application-state"><ApplicationStatus value={row.status} /><small>{String(row.checkpoint ?? t('applications.noCheckpoint'))}</small></span> },
    { label: t('applications.outcome'), value: row => row.resultStatus ? <span className="admin-application-state"><strong>{t(`applications.outcome.${String(row.resultStatus)}`)}</strong><small>{row.durationMs == null ? t('applications.noDuration') : `${Math.round(Number(row.durationMs) / 1000)}s`}</small></span> : <span className="admin-muted">{t('applications.noResult')}</span> },
    { label: t('applications.execution'), value: row => <span className="admin-application-state"><strong>{String(row.atsType ?? t('applications.notAvailable'))}</strong><small>{[row.mode, row.flowUsed].filter(Boolean).join(' · ') || t('applications.notAvailable')}</small></span> },
    { label: t('ops.errorClass'), value: row => String(row.errorClass ?? row.resultErrorClass ?? '—') },
    { label: t('applications.updated'), sortKey: 'updatedAt', value: values.date('updatedAt') },
    { label: t('ops.actions'), value: (row, controls) => <ApplicationActions row={row} permissions={permissions} controls={controls} onNotice={setNotice} /> },
  ]} filters={[
    { label: t('applications.lifecycle'), param: 'status', options: APPLICATION_STATUSES.map(value => ({ label: t(`applications.status.${value}`), value })) },
    { label: t('applications.outcome'), param: 'outcome', options: ['submitted', 'manual', 'failed', 'dry-run'].map(value => ({ label: t(`applications.outcome.${value}`), value })) },
    { label: t('ops.mode'), param: 'mode', options: [{ label: t('ops.unattended'), value: 'unattended' }, { label: t('ops.assisted'), value: 'assisted' }] },
  ]} renderSummary={summary => <div className="admin-application-summary" aria-label={t('applications.summary')}>{['total', 'needsAttention', 'inProgress', 'submitted', 'failed', 'cancelled'].map(key => <article key={key}><span>{t(`applications.summary.${key}`)}</span><strong>{summary[key] ?? 0}</strong></article>)}</div>} emptyTitle={t('applications.emptyTitle')} emptyDescription={t('applications.emptyDescription')} exportEndpoint="/api/admin/v1/export?resource=applications" bulkActions={bulkActions} />{dialog}</>
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
