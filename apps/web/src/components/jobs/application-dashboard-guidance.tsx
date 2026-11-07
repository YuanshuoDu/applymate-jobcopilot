'use client'

import React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import type { DashboardData } from '@/lib/types'
import { ApplicationTaskCard } from './application-task-card'
import { getApplicationTaskState, type ApplicationTaskView } from './application-task-model'

type Props = {
  tasks: ApplicationTaskView[]
  loading: boolean
  error: 'unavailable' | null
  limited: boolean
  savedJobs: DashboardData['savedJobs']
  followUps: DashboardData['followUpsDue']
  onOpenApplication: (jobId: string) => void
  onOpenSession: (sessionId: string) => void
  onOpenAttention: () => void
  onOpenApplications: () => void
  onRefresh: () => void
  onDiscover: () => void
  t: (key: string) => string
}

export function ApplicationDashboardGuidance({ tasks, loading, error, limited, savedJobs, followUps, onOpenApplication, onOpenSession, onOpenAttention, onOpenApplications, onRefresh, onDiscover, t }: Props) {
  const knownTasks = loading || error ? [] : tasks
  const allAttention = knownTasks.filter(task => getApplicationTaskState(task).needsAttention)
  const ongoing = knownTasks.filter(task => ['preparing', 'filling', 'submitting'].includes(getApplicationTaskState(task).kind))
  const otherTasks = knownTasks.filter(task => {
    const state = getApplicationTaskState(task)
    return !state.needsAttention && !['preparing', 'filling', 'submitting'].includes(state.kind)
  })
  const prioritizedTasks = [...allAttention, ...ongoing, ...otherTasks]
  const cards = prioritizedTasks.slice(0, 3)
  const displayedOrOngoingIds = new Set([...allAttention, ...ongoing].map(task => task.jobId))
  const knownTaskJobIds = new Set(knownTasks.map(task => task.jobId))
  const followUp = followUps.find(job => !displayedOrOngoingIds.has(job.id))
  const savedJob = savedJobs.find(job => job.id !== followUp?.id && !knownTaskJobIds.has(job.id))
  const suggestionsAvailable = !loading && !error && !limited
  return <section className="application-dashboard-guidance" aria-labelledby="application-next-steps">
    <div className="application-dashboard-guidance-heading">
      <h2 id="application-next-steps">{t('application.nextSteps')}</h2>
      <p>{t('application.taskCoverage')}</p>
    </div>
    {loading && <p role="status">{t('dashboard.momentum.loading')}</p>}
    {error && <div role="status"><p>{t('dashboard.momentum.loadErrorDetail')}</p><button type="button" onClick={onRefresh}>{t('dashboard.momentum.tryAgain')}</button></div>}
    {limited && !loading && !error && <div role="status"><p>{t('application.partialSuggestions')}</p><button type="button" onClick={onRefresh}>{t('application.refreshStatus')}</button></div>}
    {cards.length > 0 && <div className="application-dashboard-task-list">{cards.map(task => <div key={task.id}>
      <ApplicationTaskCard task={task} onOpenSession={onOpenSession} />
      {!task.sessionId && <a href={`/?page=jobs&highlight=${encodeURIComponent(task.jobId)}`} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        onOpenApplication(task.jobId)
      }} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 36 }}>{t('application.viewApplication')}</a>}
    </div>)}</div>}
    {allAttention.length > 0 && <button type="button" onClick={onOpenAttention} style={{ minHeight: 36, marginTop: 8, padding: '4px 0', border: 0, background: 'transparent', color: 'var(--primary)', fontWeight: 600, cursor: 'pointer' }}>{t('application.viewRecentAttention')}</button>}
    {prioritizedTasks.length > cards.length && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
      <p>{t('application.dashboardMoreTasks')}</p>
      <Link href="/?page=jobs" onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        onOpenApplications()
      }}>{t('application.allApplications')}</Link>
    </div>}
    <div className="application-dashboard-links">
      {suggestionsAvailable && followUp && <button type="button" onClick={() => onOpenApplication(followUp.id)}>
        <span><small>{t('application.followUp')}</small><strong>{followUp.company} · {followUp.role}</strong></span><ArrowRight size={17} aria-hidden="true" />
      </button>}
      {suggestionsAvailable && savedJob && <button type="button" onClick={() => onOpenApplication(savedJob.id)}>
        <span><small>{t('application.savedContinue')}</small><strong>{savedJob.company} · {savedJob.role}</strong></span><ArrowRight size={17} aria-hidden="true" />
      </button>}
      {suggestionsAvailable && !savedJob && !followUp && cards.length === 0 && <button type="button" onClick={onDiscover}><span>{t('dashboard.momentum.savePromising')}</span><ArrowRight size={17} aria-hidden="true" /></button>}
    </div>
  </section>
}
