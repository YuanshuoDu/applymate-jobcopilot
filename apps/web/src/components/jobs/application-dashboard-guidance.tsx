'use client'

import React from 'react'
import { ArrowRight } from 'lucide-react'
import type { DashboardData } from '@/lib/types'
import { ApplicationTaskCard } from './application-task-card'
import { getApplicationTaskState, type ApplicationTaskView } from './application-task-model'

type Props = {
  tasks: ApplicationTaskView[]
  loading: boolean
  error: 'unavailable' | null
  savedJobs: DashboardData['savedJobs']
  followUps: DashboardData['followUpsDue']
  onOpenApplication: (jobId: string) => void
  onOpenSession: (sessionId: string) => void
  onOpenAttention: () => void
  onRefresh: () => void
  onDiscover: () => void
  t: (key: string) => string
}

export function ApplicationDashboardGuidance({ tasks, loading, error, savedJobs, followUps, onOpenApplication, onOpenSession, onOpenAttention, onRefresh, onDiscover, t }: Props) {
  const allAttention = tasks.filter(task => getApplicationTaskState(task).needsAttention)
  const attention = allAttention.slice(0, 3)
  const attentionIds = new Set(allAttention.map(task => task.jobId))
  const followUp = followUps.find(job => !attentionIds.has(job.id))
  const savedJob = savedJobs.find(job => job.id !== followUp?.id && !attentionIds.has(job.id))
  return <section className="application-dashboard-guidance" aria-labelledby="application-next-steps">
    <div className="application-dashboard-guidance-heading">
      <h2 id="application-next-steps">{t('application.nextSteps')}</h2>
      <p>{t('application.taskCoverage')}</p>
    </div>
    {loading && <p role="status">{t('dashboard.momentum.loading')}</p>}
    {error && <div role="status"><p>{t('dashboard.momentum.loadErrorDetail')}</p><button type="button" onClick={onRefresh}>{t('dashboard.momentum.tryAgain')}</button></div>}
    {attention.length > 0 && <div className="application-dashboard-task-list">{attention.map(task => <ApplicationTaskCard key={task.id} task={task} onOpenSession={onOpenSession} />)}</div>}
    {attention.length > 0 && <button type="button" onClick={onOpenAttention} style={{ minHeight: 36, marginTop: 8, padding: '4px 0', border: 0, background: 'transparent', color: 'var(--primary)', fontWeight: 600, cursor: 'pointer' }}>{t('application.viewRecentAttention')}</button>}
    <div className="application-dashboard-links">
      {followUp && <button type="button" onClick={() => onOpenApplication(followUp.id)}>
        <span><small>{t('application.followUp')}</small><strong>{followUp.company} · {followUp.role}</strong></span><ArrowRight size={17} aria-hidden="true" />
      </button>}
      {savedJob && <button type="button" onClick={() => onOpenApplication(savedJob.id)}>
        <span><small>{t('application.savedContinue')}</small><strong>{savedJob.company} · {savedJob.role}</strong></span><ArrowRight size={17} aria-hidden="true" />
      </button>}
      {!savedJob && !followUp && attention.length === 0 && !loading && !error && <button type="button" onClick={onDiscover}><span>{t('dashboard.momentum.savePromising')}</span><ArrowRight size={17} aria-hidden="true" /></button>}
    </div>
  </section>
}
