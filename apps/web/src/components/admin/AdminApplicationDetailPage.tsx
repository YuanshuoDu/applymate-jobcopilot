'use client'

import Link from 'next/link'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useApi } from '@/lib/hooks'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type Application = {
  id: string
  userId: string
  jobId: string
  company: string
  role: string
  source: string
  status: string
  checkpoint: string | null
  errorClass: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  resultId: number | null
  resultStatus: string | null
  mode: string | null
  atsType: string | null
  flowUsed: string | null
  resultErrorClass: string | null
  durationMs: number | null
}

type Detail = {
  application: Application
  task: {
    id: string
    status: string
    checkpoint: string | null
    errorClass: string | null
    startedAt: string | null
    completedAt: string | null
    events: Array<{ id: string; type: string; actor: string; body: string; createdAt: string }>
  }
}

const STATUSES = ['discovered', 'analyzing', 'generating_materials', 'filling', 'waiting_for_user', 'waiting_for_authorization', 'submitted', 'skipped', 'failed', 'cancelled']

export function AdminApplicationDetailPage({ applicationId, permissions }: { applicationId: string; permissions: readonly string[] }) {
  const { t } = useI18n()
  const { data, loading, error, refetch } = useApi<Detail>(`/api/admin/v1/applications/${applicationId}`, { cache: false })
  const { request, dialog } = useAdminPrompt()
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const application = data?.application
  const statusLabel = (value: string) => STATUSES.includes(value) ? t(`applications.status.${value}`) : t('applications.status.unknown')
  const outcomeLabel = (value: string | null) => value ? t(`applications.outcome.${value}`) : '—'
  const date = (value: string | null) => value ? new Date(value).toLocaleString() : '—'

  async function act(action: 'retry' | 'cancel' | 'manual_review') {
    if (!application) return
    const reason = await request({ title: t('applicationDetail.confirmAction'), label: t('applicationDetail.operationalReason'), kind: 'reason', description: t('applicationDetail.auditDescription'), submitLabel: t('common.continue') })
    if (!reason) return
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/v1/applications/${application.id}/action`, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ action, reason }) })
      const payload = await response.json().catch(() => null) as { error?: string } | null
      setNotice(response.ok ? t('applications.actionSucceeded') : payload?.error ?? t('applications.actionFailed'))
      if (response.ok) await refetch()
    } catch {
      setNotice(t('applications.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  function actionButtons() {
    if (!application) return null
    return <div className="admin-action-group" style={{ marginTop: 18 }}>
      {permissions.includes('applications.retry') && ['failed', 'cancelled'].includes(application.status) && <button className="admin-secondary" type="button" disabled={busy} onClick={() => void act('retry')}>{t('applicationDetail.retry')}</button>}
      {permissions.includes('applications.manual_review') && !['submitted', 'cancelled'].includes(application.status) && <button className="admin-secondary" type="button" disabled={busy} onClick={() => void act('manual_review')}>{t('applicationDetail.manualReview')}</button>}
      {permissions.includes('applications.cancel') && !['submitted', 'skipped', 'cancelled'].includes(application.status) && <button className="admin-secondary" type="button" disabled={busy} onClick={() => void act('cancel')}>{t('applicationDetail.cancel')}</button>}
    </div>
  }

  return <>
    <div className="admin-page">
      <header className="admin-header">
        <div>
          <Link prefetch={false} className="admin-back" href="/admin/applications"><ArrowLeft size={16} /> {t('applicationDetail.applications')}</Link>
          <h1>{t('applicationDetail.title')}</h1>
          <p>{t('applicationDetail.description')}</p>
        </div>
        <button className="admin-secondary" type="button" onClick={() => void refetch()}><RefreshCw size={14} /> {t('common.refresh')}</button>
      </header>
      {notice && <div className="admin-operation-status" role="status">{notice}</div>}
      {error && <div className="admin-alert">{error}</div>}
      {loading && !application && <div className="admin-placeholder"><section>{t('applicationDetail.loading')}</section></div>}
      {application && <div className="admin-detail">
        <section className="admin-detail-grid">
          <section>
            <h2>{t('applicationDetail.executionTask')}</h2>
            <dl>
              <dt>{t('applicationDetail.taskId')}</dt><dd>{application.id}</dd>
              <dt>{t('applicationDetail.lifecycle')}</dt><dd><strong className="admin-status-badge" data-status={application.status}>{statusLabel(application.status)}</strong></dd>
              <dt>{t('applicationDetail.checkpoint')}</dt><dd>{application.checkpoint ?? '—'}</dd>
              <dt>{t('applicationDetail.created')}</dt><dd>{date(application.createdAt)}</dd>
              <dt>{t('applicationDetail.updated')}</dt><dd>{date(application.updatedAt)}</dd>
              <dt>{t('applicationDetail.started')}</dt><dd>{date(application.startedAt)}</dd>
              <dt>{t('applicationDetail.completed')}</dt><dd>{date(application.completedAt)}</dd>
              <dt>{t('applicationDetail.errorClass')}</dt><dd>{application.errorClass ?? '—'}</dd>
            </dl>
          </section>
          <section>
            <h2>{t('applicationDetail.job')}</h2>
            <dl>
              <dt>{t('applicationDetail.role')}</dt><dd>{application.role}</dd>
              <dt>{t('applicationDetail.company')}</dt><dd>{application.company}</dd>
              <dt>{t('applicationDetail.source')}</dt><dd>{application.source}</dd>
              <dt>{t('applicationDetail.id')}</dt><dd>{application.jobId}</dd>
              <dt>{t('applicationDetail.candidate')}</dt><dd><Link className="admin-table-link" href={`/admin/users/${application.userId}`}>{application.userId}</Link></dd>
            </dl>
            {actionButtons()}
          </section>
        </section>
        <section className="admin-detail-history">
          <h2>{t('applicationDetail.latestOutcome')}</h2>
          {application.resultId === null ? <p>{t('applicationDetail.noResult')}</p> : <dl className="admin-detail-inline">
            <dt>{t('common.status')}</dt><dd>{outcomeLabel(application.resultStatus)}</dd>
            <dt>{t('applicationDetail.mode')}</dt><dd>{application.mode ?? '—'}</dd>
            <dt>{t('applicationDetail.ats')}</dt><dd>{application.atsType ?? '—'}</dd>
            <dt>{t('applicationDetail.flow')}</dt><dd>{application.flowUsed ?? '—'}</dd>
            <dt>{t('applicationDetail.duration')}</dt><dd>{application.durationMs == null ? '—' : `${Math.round(application.durationMs / 1000)}s`}</dd>
            <dt>{t('applicationDetail.errorClass')}</dt><dd>{application.resultErrorClass ?? '—'}</dd>
          </dl>}
        </section>
        <section className="admin-detail-history">
          <h2>{t('applicationDetail.taskEvents')}</h2>
          <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('applicationDetail.time')}</th><th>{t('applicationDetail.type')}</th><th>{t('applicationDetail.actor')}</th><th>{t('applicationDetail.safeNote')}</th></tr></thead><tbody>
            {data.task.events.length ? data.task.events.map(event => <tr key={event.id}><td>{date(event.createdAt)}</td><td>{event.type}</td><td>{event.actor}</td><td>{event.body}</td></tr>) : <tr><td colSpan={4}>{t('applicationDetail.noEvents')}</td></tr>}
          </tbody></table></div>
        </section>
      </div>}
    </div>
    {dialog}
  </>
}
