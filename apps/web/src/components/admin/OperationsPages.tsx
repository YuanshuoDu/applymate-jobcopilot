'use client'

import { AdminDataTable, values, type BulkAction } from './AdminDataTable'
import { AdminAtsControls } from './AdminAtsControls'
import { AdminAtsQualityTrends } from './AdminAtsQualityTrends'
import { AdminBudgetControls } from './AdminBudgetControls'
import { AdminAiConfigPanel } from './AdminAiConfigPanel'
import { AdminAiUsageTrends } from './AdminAiUsageTrends'
import { useAdminPrompt } from './AdminPromptDialog'
import Link from 'next/link'

function ApplicationActions({ row, permissions }: { row: Record<string, unknown>; permissions: readonly string[] }) {
  const { request, dialog } = useAdminPrompt()
  const taskId = typeof row.taskId === 'string' ? row.taskId : null
  if (!taskId) return <span>-</span>
  async function act(action: 'retry' | 'cancel' | 'manual_review') {
    const reason = await request({ title: 'Confirm application action', label: 'Operational reason', kind: 'reason', description: 'This reason will be written to the administrator audit log.', submitLabel: 'Continue' })
    if (!reason) return
    const response = await fetch(`/api/admin/v1/applications/${taskId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ action, reason }) })
    if (response.ok) window.location.reload()
  }
  const status = String(row.taskStatus ?? '')
  return <><span className="admin-action-group">{permissions.includes('applications.retry') && ['failed', 'cancelled'].includes(status) && <button className="admin-row-action" title="Retry application" onClick={() => void act('retry')}>Retry</button>}{permissions.includes('applications.manual_review') && !['submitted', 'cancelled'].includes(status) && <button className="admin-row-action" title="Move to manual review" onClick={() => void act('manual_review')}>Review</button>}{permissions.includes('applications.cancel') && !['submitted', 'skipped', 'cancelled'].includes(status) && <button className="admin-row-action" title="Cancel application" onClick={() => void act('cancel')}>Cancel</button>}</span>{dialog}</>
}

export function AdminUsersPage({ canExport = false, permissions = [] }: { canExport?: boolean; permissions?: readonly string[] }) {
  const { request, dialog } = useAdminPrompt()
  async function runBulk(action: 'suspend' | 'restore', ids: string[]) {
    const reason = await request({ title: `${action === 'suspend' ? 'Suspend' : 'Restore'} selected accounts`, label: 'Operational reason', kind: 'reason', submitLabel: 'Continue' })
    if (!reason) return
    const response = await fetch('/api/admin/v1/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ resource: 'users', action, ids, reason }) })
    if (response.ok) window.location.reload()
  }
  const bulkActions: BulkAction[] = [
    ...(permissions.includes('users.suspend') ? [{ label: 'Suspend selected', onRun: (ids: string[]) => runBulk('suspend', ids) }] : []),
    ...(permissions.includes('users.restore') ? [{ label: 'Restore selected', onRun: (ids: string[]) => runBulk('restore', ids) }] : []),
  ]
  return <><div className="admin-list-toolbar"><span>Exports contain deterministic hashes only; no email, resume, or document content.</span>{canExport && <Link className="admin-secondary" href="/api/admin/v1/export?resource=users">Download anonymized CSV</Link>}</div><AdminDataTable title="Users" subtitle="Masked account metadata and operational status" endpoint="/api/admin/v1/users" searchable columns={[
    { label: 'User', value: (row) => <Link className="admin-table-link" href={`/admin/users/${row.id}`}>{String(row.name ?? 'Unnamed')} · {String(row.email ?? '')}</Link> }, { label: 'Plan', value: values.text('plan') },
    { label: 'Status', sortKey: 'accountStatus', value: values.text('accountStatus') }, { label: 'Location', value: values.text('location') }, { label: 'Jobs', sortKey: 'jobsCount', value: values.text('jobsCount') }, { label: 'Resume', value: (row) => row.resumeExists ? 'On file' : 'Not uploaded' }, { label: 'Joined', sortKey: 'createdAt', value: values.date('createdAt') },
  ]} filters={[{ label: 'Plan', param: 'plan', options: [{ label: 'Free', value: 'free' }, { label: 'Pro', value: 'pro' }, { label: 'Enterprise', value: 'enterprise' }] }, { label: 'Status', param: 'status', options: [{ label: 'Active', value: 'active' }, { label: 'Suspended', value: 'suspended' }] }]} exportEndpoint={canExport ? '/api/admin/v1/export?resource=users' : undefined} bulkActions={bulkActions} />{dialog}</>
}

export function AdminAtsPage({ permissions }: { permissions: readonly string[] }) {
  return <><AdminDataTable title="ATS sources" subtitle="Registry, discovery volume, and hard rate-limit metadata" endpoint="/api/admin/v1/ats" columns={[
    { label: 'Source', sortKey: 'name', value: (row) => `${row.atsType} · ${row.name ?? row.slug}` }, { label: 'Jobs', sortKey: 'jobCount', value: values.text('jobCount') },
    { label: 'RPS ceiling', value: (row) => row.rateLimitRps ? `${row.rateLimitRps} rps` : 'Not registered' }, { label: 'Last seen', sortKey: 'lastSeen', value: values.date('lastSeen') }, { label: 'Credential', value: (row) => row.credentialRequirement === 'none' ? 'Not required' : row.credentialConfigured ? 'Configured' : 'Not reported' },
  ]} exportEndpoint="/api/admin/v1/export?resource=ats" /><AdminAtsControls permissions={permissions} /><AdminAtsQualityTrends /></>
}

export function AdminApplicationsPage({ permissions = [] }: { permissions?: readonly string[] }) {
  const { request, dialog } = useAdminPrompt()
  async function runBulk(action: 'cancel' | 'manual_review', ids: string[]) {
    const reason = await request({ title: `${action === 'cancel' ? 'Cancel' : 'Move'} selected applications`, label: 'Operational reason', kind: 'reason', submitLabel: 'Continue' })
    if (!reason) return
    const response = await fetch('/api/admin/v1/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ resource: 'applications', action, ids, reason }) })
    if (response.ok) window.location.reload()
  }
  const bulkActions: BulkAction[] = [
    ...(permissions.includes('applications.cancel') ? [{ label: 'Cancel selected', onRun: (ids: string[]) => runBulk('cancel', ids) }] : []),
    ...(permissions.includes('applications.manual_review') ? [{ label: 'Review selected', onRun: (ids: string[]) => runBulk('manual_review', ids) }] : []),
  ]
  return <><AdminDataTable title="Applications" subtitle="Safe outcome metadata without job content or candidate documents" endpoint="/api/admin/v1/applications" columns={[
    { label: 'ID', sortKey: 'createdAt', value: row => <Link className="admin-table-link" href={`/admin/applications/${row.id}`}>{String(row.id)}</Link> }, { label: 'Status', sortKey: 'status', value: values.text('status') }, { label: 'ATS', value: values.text('atsType') }, { label: 'Flow', value: values.text('flowUsed') },
    { label: 'Mode', value: values.text('mode') }, { label: 'Error class', value: values.text('errorClass') }, { label: 'Duration', sortKey: 'durationMs', value: values.duration('durationMs') }, { label: 'Created', sortKey: 'createdAt', value: values.date('createdAt') }, { label: 'Task', value: values.text('taskStatus') }, { label: 'Actions', value: row => <ApplicationActions row={row} permissions={permissions} /> },
  ]} filters={[{ label: 'Status', param: 'status', options: [{ label: 'Submitted', value: 'submitted' }, { label: 'Failed', value: 'failed' }, { label: 'Manual', value: 'manual' }] }, { label: 'Mode', param: 'mode', options: [{ label: 'Unattended', value: 'unattended' }, { label: 'Assisted', value: 'assisted' }] }]} exportEndpoint="/api/admin/v1/export?resource=applications" bulkActions={bulkActions} />{dialog}</>
}

export function AdminAiPage({ permissions }: { permissions: readonly string[] }) {
  return <><AdminDataTable title="AI operations" subtitle="Monthly budget accounting and remaining credits" endpoint="/api/admin/v1/ai/budgets" columns={[
    { label: 'User ID', value: values.text('userId') }, { label: 'Month', value: values.text('month') }, { label: 'Used', sortKey: 'used', value: values.text('used') },
    { label: 'Limit', sortKey: 'limit', value: values.text('limit') }, { label: 'Remaining', value: values.text('remaining') }, { label: 'Updated', sortKey: 'updatedAt', value: values.date('updatedAt') },
  ]} exportEndpoint="/api/admin/v1/export?resource=ai-budgets" /><AdminBudgetControls canUpdate={permissions.includes('ai_budget.update')} /><AdminAiConfigPanel canUpdate={permissions.includes('ai_budget.update')} /><AdminAiUsageTrends /></>
}

export function AdminAuditPage() {
  return <AdminDataTable title="Audit" subtitle="Append-only security and operational event metadata" endpoint="/api/admin/v1/audit" columns={[
    { label: 'Action', sortKey: 'action', value: values.text('action') }, { label: 'Outcome', sortKey: 'outcome', value: values.text('outcome') }, { label: 'Role', value: values.text('actorRoleKey') },
    { label: 'Target', value: (row) => row.targetType ? `${row.targetType} · ${row.targetId ?? '-'}` : '-' }, { label: 'Error code', value: values.text('errorCode') }, { label: 'Time', sortKey: 'createdAt', value: values.date('createdAt') },
  ]} exportEndpoint="/api/admin/v1/export?resource=audit" />
}
