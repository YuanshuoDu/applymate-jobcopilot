'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'
import { applicationTaskSessionHref, getApplicationTaskState, type ApplicationTaskView } from './application-task-model'

export function ApplicationTaskCard({ task, onOpenSession }: {
  task: ApplicationTaskView
  onOpenSession?: (sessionId: string) => void
}) {
  const { t } = useI18n()
  const state = getApplicationTaskState(task)
  const href = applicationTaskSessionHref(task)
  return <section aria-label={`${task.company} · ${task.role}`} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, background: 'var(--bg-secondary)', minWidth: 0 }}>
    <div style={{ fontSize: 13, fontWeight: 700, overflowWrap: 'anywhere' }}>{task.company} · {task.role}</div>
    <p style={{ margin: '8px 0 4px', fontSize: 13, fontWeight: 650 }}>{t(state.labelKey)}</p>
    <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>{t(state.descriptionKey)}</p>
    {href ? <a href={href} onClick={event => {
      if (!onOpenSession || !task.sessionId || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      onOpenSession(task.sessionId)
    }} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 36, color: 'var(--accent, #4f46e5)', fontSize: 13, fontWeight: 650 }}>{t(state.actionKey)}</a>
      : <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>{t('jobs.task.sessionUnavailable')}</p>}
  </section>
}
