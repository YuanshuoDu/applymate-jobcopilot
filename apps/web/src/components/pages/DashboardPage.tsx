'use client'

import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight, BriefcaseBusiness, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  Eye, FileText, MailCheck, MoreVertical, Send, Sparkles, Target, X,
} from 'lucide-react'
import { Btn, ScorePill, useToast } from '@/components/ui'
import type { Activity, DashboardApplicationDay, DashboardData, DashboardRecommendation, DashboardSavedJob } from '@/lib/types'
import { apiMutate, fmtDate, useApi } from '@/lib/hooks'
import { useNav } from '@/lib/nav-context'
import './DashboardPage.css'

const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function getWeekRange(offset: number) {
  const start = new Date()
  const day = start.getDay() || 7
  start.setDate(start.getDate() - day + 1 + offset * 7)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

function formatWeekRange(range: { start: Date; end: Date }) {
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  return `${range.start.toLocaleDateString('en-GB', options)} – ${range.end.toLocaleDateString('en-GB', { ...options, year: 'numeric' })}`
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function CompanyBadge({ company, logo }: { company: string; logo?: string | null }) {
  if (logo?.startsWith('http')) return <img className="momentum-company-logo" src={logo} alt="" />
  return <span className="momentum-company-logo momentum-logo-fallback"><BriefcaseBusiness size={15} /></span>
}

function WeekGoal({ completed, applicationDays, range }: { completed: number; applicationDays: DashboardApplicationDay[]; range: { start: Date; end: Date } }) {
  const target = 12
  const value = Math.min(completed, target)
  const progress = Math.round((value / target) * 100)
  const applicationsByDay = new Map(applicationDays.map(day => [day.date, day.count]))
  const todayKey = dateKey(new Date())

  return (
    <section className="momentum-week-goal">
      <div className="momentum-ring" style={{ '--progress': `${progress * 3.6}deg` } as React.CSSProperties}>
        <div><strong>{value}</strong><span>of {target}</span><small>quality applications<br />this week</small></div>
      </div>
      <div className="momentum-week-copy">
        <span className="momentum-section-kicker"><Sparkles size={15} /> Keep it up!</span>
        <h2>You&apos;re building real momentum.</h2>
        <p>Aim for {target} quality applications this week to maximise your chances and keep your pipeline strong.</p>
        <div className="momentum-days" aria-label={`${progress}% of weekly goal complete`}>
          {WEEK_DAYS.map((day, index) => {
            const date = new Date(range.start)
            date.setDate(range.start.getDate() + index)
            const key = dateKey(date)
            const applicationCount = applicationsByDay.get(key) ?? 0
            const state = applicationCount > 0 ? 'is-done' : key < todayKey ? 'is-missed' : key === todayKey ? 'is-today' : ''
            const label = applicationCount > 0 ? `${applicationCount} application${applicationCount === 1 ? '' : 's'} submitted` : state === 'is-missed' ? 'No application submitted' : state === 'is-today' ? 'Today' : 'Upcoming day'
            return <div key={key}><small>{day}</small><span className={state} title={label}>{applicationCount > 0 ? <Check size={11} /> : state === 'is-missed' ? <X size={11} /> : null}</span></div>
          })}
        </div>
        <div className="momentum-goal-legend"><span><i className="is-done"><Check size={9} /></i> Applied</span><span><i className="is-missed"><X size={9} /></i> Missed</span></div>
      </div>
    </section>
  )
}

function CoachCard({ hasResume, savedJobs, onAction }: { hasResume: boolean; savedJobs: number; onAction: () => void }) {
  const title = !hasResume ? 'Finish your resume for tailored matches' : savedJobs > 0 ? 'Focus on your strongest matches' : 'Focus on one high-impact improvement'
  const detail = !hasResume
    ? 'Upload your resume and the agent will tailor every recommendation to your experience.'
    : savedJobs > 0
      ? `${savedJobs} high-match role${savedJobs === 1 ? '' : 's'} are ready for your next step.`
      : 'Add 2–3 quantified achievements to make your experience easier for recruiters to scan.'

  return (
    <section className="momentum-coach-card">
      <span className="momentum-coach-icon"><Sparkles size={21} /></span>
      <div><small>Your AI coach</small><h2>{title}</h2><p>{detail}</p><button onClick={onAction}>{!hasResume ? 'Add your resume' : savedJobs > 0 ? 'Review matches' : 'Improve resume'} <ArrowRight size={14} /></button></div>
      <span className="momentum-coach-document"><FileText size={36} /><Sparkles size={17} /></span>
    </section>
  )
}

function MatchList({ jobs, threshold, onReview }: { jobs: DashboardSavedJob[]; threshold: number; onReview: () => void }) {
  return (
    <section className="momentum-side-card momentum-matches-card">
      <div className="momentum-side-title"><Sparkles size={18} /><div><h2>High-match roles</h2><p>{jobs.length > 0 ? `${jobs.length} roles at ${threshold}%+ waiting for approval` : `Saved roles scoring ${threshold}%+ appear here`}</p></div></div>
      <div className="momentum-match-list">
        {jobs.length === 0 ? <div className="momentum-side-empty"><BriefcaseBusiness size={19} /> Save promising roles to compare them here.</div> : jobs.slice(0, 3).map(job => (
          <article className="momentum-match" key={job.id}>
            <CompanyBadge company={job.company} />
            <div className="momentum-match-copy"><strong>{job.role}</strong><span>{job.company}</span><small>Saved match</small></div>
            <ScorePill score={job.score} />
            <button onClick={onReview} aria-label={`View ${job.role} at ${job.company}`}>View <ArrowRight size={15} /></button>
          </article>
        ))}
      </div>
      <button className="momentum-link" onClick={onReview}>View all matches <ArrowRight size={15} /></button>
    </section>
  )
}

function Timeline({ activities, onJobs }: { activities: Activity[]; onJobs: () => void }) {
  const [sortBy, setSortBy] = useState<'recent' | 'company'>('recent')
  const [sortOpen, setSortOpen] = useState(false)
  const [page, setPage] = useState(0)
  const applicationActivities = activities.filter(activity => ['applied', 'interview_scheduled', 'offer_received', 'rejected', 'status_changed'].includes(activity.type))
  const sortedActivities = [...applicationActivities].sort((a, b) => sortBy === 'company'
    ? (a.job?.company ?? '').localeCompare(b.job?.company ?? '')
    : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const pageSize = 10
  const pageCount = Math.max(1, Math.ceil(sortedActivities.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pageActivities = sortedActivities.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  return (
    <section className="momentum-timeline-card">
      <div className="momentum-timeline-heading"><h2>Your application timeline</h2><div className="momentum-sort"><button onClick={() => setSortOpen(open => !open)} aria-expanded={sortOpen}>{sortBy === 'recent' ? 'Most recent' : 'Company'} <ChevronDown size={14} /></button>{sortOpen && <div><button onClick={() => { setSortBy('recent'); setPage(0); setSortOpen(false) }}>Most recent</button><button onClick={() => { setSortBy('company'); setPage(0); setSortOpen(false) }}>Company</button></div>}</div></div>
      {activities.length === 0 ? (
        <div className="momentum-timeline-empty"><Target size={20} /> Your application activity will appear here.</div>
      ) : (
        <div className="momentum-table">
          {pageActivities.map(activity => (
            <div className="momentum-row" key={activity.id}>
              <span className={`momentum-row-status ${activity.type === 'rejected' ? 'is-rejected' : 'is-complete'}`}>{activity.type === 'rejected' ? <X size={11} /> : <Check size={11} />}</span>
              <CompanyBadge company={activity.job?.company ?? 'Gmail'} />
              <div className="momentum-row-role"><strong>{activity.job?.role ?? 'Application update'}</strong><span>{activity.text}</span></div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{activityLabel(activity.type)}</span>
              <time>{fmtDate(activity.createdAt)}</time>
              <button onClick={onJobs}>View <ArrowRight size={12} /></button>
              <MoreVertical size={16} className="momentum-row-more" />
            </div>
          ))}
        </div>
      )}
      {sortedActivities.length > pageSize && <div className="momentum-timeline-pagination"><button aria-label="Previous timeline page" disabled={currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft size={14} /></button><span>{currentPage + 1} / {pageCount}</span><button aria-label="Next timeline page" disabled={currentPage >= pageCount - 1} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}><ChevronRight size={14} /></button></div>}
      <button className="momentum-link momentum-center-link" onClick={onJobs}>View full application history <ArrowRight size={15} /></button>
    </section>
  )
}

function activityLabel(type: Activity['type']): string {
  if (type === 'applied') return 'Applied'
  if (type === 'interview_scheduled') return 'Interview'
  if (type === 'offer_received') return 'Offer'
  if (type === 'rejected') return 'Rejected'
  if (type === 'status_changed') return 'Status update'
  return 'Activity'
}

function WeekAtAGlance({ stats, onJobs }: { stats: DashboardData['stats']; onJobs: () => void }) {
  const target = 12
  const progress = Math.min((stats.thisWeek / target) * 100, 100)
  return (
    <section className="momentum-side-card momentum-glance-card">
      <div className="momentum-side-title"><Target size={19} /><div><h2>This week at a glance</h2></div></div>
      <div className="momentum-glance-line"><span className="momentum-glance-icon"><Send size={17} /></span><div><small>Applications</small><strong>{stats.thisWeek} of {target}</strong><i><b style={{ width: `${progress}%` }} /></i></div></div>
      <div className="momentum-glance-line"><span className="momentum-glance-icon"><Eye size={17} /></span><div><small>Tracked roles</small><strong>{stats.total}</strong></div></div>
      <div className="momentum-glance-line"><span className="momentum-glance-icon"><Target size={17} /></span><div><small>Interviews</small><strong>{stats.interviews}</strong></div></div>
      <button className="momentum-link" onClick={onJobs}>View full insights <ArrowRight size={15} /></button>
    </section>
  )
}

function JobNotifications({ recommendations, onReview }: { recommendations: DashboardRecommendation[]; onReview: () => void }) {
  return <section className="momentum-side-card momentum-notifications-card">
    <div className="momentum-side-title"><MailCheck size={19} /><div><h2>Job notifications</h2><p>{recommendations.length ? `${recommendations.length} new role${recommendations.length === 1 ? '' : 's'} from today’s subscriptions` : 'Today’s subscription emails appear here'}</p></div></div>
    {recommendations.length === 0 ? <div className="momentum-side-empty"><MailCheck size={19} /> No new job subscriptions today.</div> : <div className="momentum-notification-list">{recommendations.map(job => <button className="momentum-notification" key={job.id} onClick={onReview}><span className="momentum-notification-icon"><BriefcaseBusiness size={15} /></span><span><strong>{job.role ?? 'Job recommendation'}</strong><small>{[job.company, job.location, job.platform].filter(Boolean).join(' · ') || 'Subscription job alert'}</small></span><ArrowRight size={14} /></button>)}</div>}
    <button className="momentum-link" onClick={onReview}>Review job recommendations <ArrowRight size={15} /></button>
  </section>
}

function ActionCard({ followUps, agentConfig, onJobs, onSettings, onUpdated }: {
  followUps: DashboardData['followUpsDue']; agentConfig: DashboardData['agentConfig']; onJobs: () => void; onSettings: () => void; onUpdated: () => void
}) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const running = agentConfig?.isRunning ?? false

  async function toggleAgent() {
    setSaving(true)
    const { error } = await apiMutate('/api/agent', 'PATCH', { isRunning: !running })
    setSaving(false)
    if (error) return toast.error('Could not update agent', error)
    toast.success(running ? 'Agent paused' : 'Agent resumed')
    onUpdated()
  }

  return <section className="momentum-side-card momentum-actions-card">
    <div className="momentum-side-title"><Target size={19} /><div><h2>Next actions</h2><p>{followUps.length ? `${followUps.length} follow-up${followUps.length === 1 ? '' : 's'} due` : 'Your pipeline is up to date'}</p></div></div>
    {followUps.length > 0 && <button className="momentum-follow-up" onClick={onJobs}><CalendarDays size={16} /><span><strong>{followUps[0].role}</strong><small>{followUps[0].company} · follow up {fmtDate(followUps[0].followUpAt)}</small></span><ArrowRight size={15} /></button>}
    <div className="momentum-agent-control"><span><i className={running ? 'is-running' : ''} /> Agent {running ? 'running' : 'paused'}</span><button onClick={toggleAgent} disabled={saving}>{saving ? 'Saving…' : running ? 'Pause' : 'Resume'}</button></div>
    <button className="momentum-link" onClick={onSettings}>Configure agent <ArrowRight size={15} /></button>
  </section>
}

export function DashboardPage() {
  const { navigate } = useNav()
  const [weekOffset, setWeekOffset] = useState(0)
  const [dateMenuOpen, setDateMenuOpen] = useState(false)
  // Keep the request key stable across renders. Recreating dates here caused
  // a new URL (and therefore a new dashboard request) after every state update.
  const selectedRange = useMemo(() => getWeekRange(weekOffset), [weekOffset])
  const dashboardUrl = useMemo(
    () => `/api/dashboard?from=${selectedRange.start.toISOString()}&to=${selectedRange.end.toISOString()}`,
    [selectedRange],
  )
  const { data, loading, error, refetch } = useApi<DashboardData>(dashboardUrl)
  const [profilePromptDismissed, setProfilePromptDismissed] = useState(false)

  useEffect(() => {
    setProfilePromptDismissed(window.sessionStorage.getItem('applymate-dismissed-resume-reminder') === 'true')
  }, [])

  function dismissProfilePrompt() {
    window.sessionStorage.setItem('applymate-dismissed-resume-reminder', 'true')
    setProfilePromptDismissed(true)
  }

  useEffect(() => {
    const id = setInterval(refetch, 30_000)
    return () => clearInterval(id)
  }, [refetch])

  if (loading) return <div className="momentum-loading">Loading your momentum dashboard…</div>
  if (error) return <div className="momentum-loading"><p>{error}</p><Btn variant="ghost" onClick={refetch}>Retry</Btn></div>

  const stats = data?.stats ?? { total: 0, saved: 0, applied: 0, inProgress: 0, interviews: 0, offers: 0, rejected: 0, thisWeek: 0 }
  const savedJobs = data?.savedJobs ?? []
  const activities = data?.activity ?? []
  const todayRecommendations = data?.todayRecommendations ?? []

  return (
    <div className="momentum-dashboard">
      <main className="momentum-content">
        {!data?.hasResume && !profilePromptDismissed && (
          <section className="momentum-profile-prompt"><FileText size={18} /><span>Add your resume to unlock tailored matches.</span><button onClick={() => navigate('resume')}>Add resume</button><button aria-label="Dismiss resume reminder" onClick={dismissProfilePrompt}><X size={15} /></button></section>
        )}
        <header className="momentum-header">
          <div><span><Sparkles size={23} /></span><div><h1>Application Momentum</h1><p>Stay consistent, focus on quality, and keep moving forward.</p></div></div>
          <div className="momentum-date-control">
            <button className="momentum-date-picker" onClick={() => setDateMenuOpen(open => !open)} aria-expanded={dateMenuOpen}><CalendarDays size={17} /> {formatWeekRange(selectedRange)} <ChevronDown size={15} /></button>
            {dateMenuOpen && <div className="momentum-date-menu">
              {[0, -1, -2, -3].map(offset => {
                const range = getWeekRange(offset)
                return <button className={offset === weekOffset ? 'is-selected' : ''} key={offset} onClick={() => { setWeekOffset(offset); setDateMenuOpen(false) }}>{offset === 0 ? 'This week' : `${Math.abs(offset)} week${offset === -1 ? '' : 's'} ago`}<small>{formatWeekRange(range)}</small></button>
              })}
            </div>}
          </div>
        </header>
        <div className="momentum-layout">
          <div className="momentum-primary-column"><WeekGoal completed={stats.thisWeek} applicationDays={data?.applicationDays ?? []} range={selectedRange} /><CoachCard hasResume={data?.hasResume ?? false} savedJobs={savedJobs.length} onAction={() => navigate(data?.hasResume ? 'jobs' : 'resume')} /><Timeline activities={activities} onJobs={() => navigate('jobs')} /></div>
          <aside className="momentum-secondary-column"><MatchList jobs={savedJobs} threshold={data?.minMatchScore ?? 75} onReview={() => navigate('jobs')} /><JobNotifications recommendations={todayRecommendations} onReview={() => navigate('gmail-recommendations')} /><WeekAtAGlance stats={stats} onJobs={() => navigate('jobs')} /><ActionCard followUps={data?.followUpsDue ?? []} agentConfig={data?.agentConfig ?? null} onJobs={() => navigate('jobs')} onSettings={() => navigate('settings')} onUpdated={refetch} /></aside>
        </div>
      </main>
    </div>
  )
}
