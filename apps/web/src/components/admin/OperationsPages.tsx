'use client'

import { AdminDataTable, values } from './AdminDataTable'
import { AdminAtsControls } from './AdminAtsControls'
import { AdminBudgetControls } from './AdminBudgetControls'
import Link from 'next/link'

export function AdminUsersPage() {
  return <AdminDataTable title="Users" subtitle="Masked account metadata and operational status" endpoint="/api/admin/v1/users" searchable columns={[
    { label: 'User', value: (row) => <Link className="admin-table-link" href={`/admin/users/${row.id}`}>{String(row.name ?? 'Unnamed')} · {String(row.email ?? '')}</Link> }, { label: 'Plan', value: values.text('plan') },
    { label: 'Location', value: values.text('location') }, { label: 'Jobs', value: values.text('jobsCount') }, { label: 'Resume', value: (row) => row.resumeExists ? 'On file' : 'Not uploaded' }, { label: 'Joined', value: values.date('createdAt') },
  ]} />
}

export function AdminAtsPage({ permissions }: { permissions: readonly string[] }) {
  return <><AdminDataTable title="ATS sources" subtitle="Registry, discovery volume, and hard rate-limit metadata" endpoint="/api/admin/v1/ats" columns={[
    { label: 'Source', value: (row) => `${row.atsType} · ${row.name ?? row.slug}` }, { label: 'Jobs', value: values.text('jobCount') },
    { label: 'RPS ceiling', value: (row) => row.rateLimitRps ? `${row.rateLimitRps} rps` : 'Not registered' }, { label: 'Last seen', value: values.date('lastSeen') }, { label: 'Credential', value: (row) => row.credentialConfigured ? 'Configured' : 'Not reported' },
  ]} /><AdminAtsControls permissions={permissions} /></>
}

export function AdminApplicationsPage() {
  return <AdminDataTable title="Applications" subtitle="Safe outcome metadata without job content or candidate documents" endpoint="/api/admin/v1/applications" columns={[
    { label: 'Status', value: values.text('status') }, { label: 'ATS', value: values.text('atsType') }, { label: 'Flow', value: values.text('flowUsed') },
    { label: 'Mode', value: values.text('mode') }, { label: 'Error class', value: values.text('errorClass') }, { label: 'Duration', value: values.duration('durationMs') }, { label: 'Created', value: values.date('createdAt') },
  ]} />
}

export function AdminAiPage({ permissions }: { permissions: readonly string[] }) {
  return <><AdminDataTable title="AI operations" subtitle="Monthly budget accounting and remaining credits" endpoint="/api/admin/v1/ai/budgets" columns={[
    { label: 'User ID', value: values.text('userId') }, { label: 'Month', value: values.text('month') }, { label: 'Used', value: values.text('used') },
    { label: 'Limit', value: values.text('limit') }, { label: 'Remaining', value: values.text('remaining') }, { label: 'Updated', value: values.date('updatedAt') },
  ]} /><AdminBudgetControls canUpdate={permissions.includes('ai_budget.update')} /></>
}

export function AdminAuditPage() {
  return <AdminDataTable title="Audit" subtitle="Append-only security and operational event metadata" endpoint="/api/admin/v1/audit" columns={[
    { label: 'Action', value: values.text('action') }, { label: 'Outcome', value: values.text('outcome') }, { label: 'Role', value: values.text('actorRoleKey') },
    { label: 'Target', value: (row) => row.targetType ? `${row.targetType} · ${row.targetId ?? '-'}` : '-' }, { label: 'Error code', value: values.text('errorCode') }, { label: 'Time', value: values.date('createdAt') },
  ]} />
}
