'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'
import { ApplicationTaskCard } from './application-task-card'
import { getApplicationTaskState, type ApplicationTaskView } from './application-task-model'

export function ApplicationTaskSummary({ task, onOpenSession }: { task: ApplicationTaskView; onOpenSession: (sessionId: string) => void }) {
  const { t } = useI18n()
  const state = getApplicationTaskState(task)
  return <div style={{ fontSize: 11, marginTop: 5, color: 'var(--text-muted)' }}>
    <strong>{t(state.labelKey)}</strong><p style={{ margin: '4px 0' }}>{t(state.descriptionKey)}</p>
    {task.sessionId ? <button type="button" onClick={event => { event.stopPropagation(); onOpenSession(task.sessionId!) }} style={{ color: 'var(--primary)', background: 'transparent', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }}>{t(state.actionKey)}</button>
      : <span>{t('jobs.task.sessionUnavailable')}</span>}
  </div>
}

/** A bounded task view, independent of the currently loaded jobs page. */
export function ApplicationAttentionView({ tasks, loading, error, onOpenJob, onOpenSession, onRefresh }: {
  tasks: ApplicationTaskView[]
  loading: boolean
  error: 'unavailable' | null
  onOpenJob: (jobId: string) => void
  onOpenSession: (sessionId: string) => void
  onRefresh: () => void
}) {
  const { t } = useI18n()
  const attention = tasks.filter(task => getApplicationTaskState(task).needsAttention)
  return <section aria-label={t('application.attentionView')} style={{ padding: 16, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg)' }}>
    <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: 12 }}>{t('application.taskCoverage')}</p>
    {loading ? <p role="status">{t('application.attentionLoading')}</p> : error ? <div role="status"><p>{t('application.attentionUnavailable')}</p><button type="button" onClick={onRefresh}>{t('application.refreshStatus')}</button></div>
      : attention.length === 0 ? <p>{t('application.recentAttentionEmpty')}</p>
        : <div style={{ display: 'grid', gap: 12 }}>{attention.map(task => <div key={task.id}>
          <ApplicationTaskCard task={task} onOpenSession={onOpenSession} />
          <a href={`/?page=jobs&highlight=${encodeURIComponent(task.jobId)}`} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            onOpenJob(task.jobId)
          }} style={{ display: 'inline-flex', alignItems: 'center', marginTop: 6, minHeight: 36 }}>{t('application.viewApplication')}</a>
        </div>)}</div>}
  </section>
}
