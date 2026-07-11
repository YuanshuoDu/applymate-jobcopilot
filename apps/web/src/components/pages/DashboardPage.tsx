'use client'

import React, { useState, useEffect } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, ScorePill, StatusBadge, useToast } from '@/components/ui'
import type { DashboardData, DashboardFollowUp, DashboardSavedJob, AgentConfig, JobStatus } from '@/lib/types'
import { useApi, apiMutate, fmtDate, fmtRelative } from '@/lib/hooks'
import { useNav } from '@/lib/nav-context'
import { useI18n } from '@/lib/i18n'
import { OnboardingChecklist } from '@/components/onboarding/OnboardingChecklist'

const ACTIVITY_COLORS: Record<string, string> = {
  applied:             'var(--primary)',
  interview_scheduled: 'var(--c-success)',
  offer_received:      'var(--c-info)',
  rejected:            'var(--c-danger)',
  email_sent:          'var(--c-warning)',
  agent_action:        'var(--primary)',
  resume_tailored:     'var(--accent)',
  status_changed:      'var(--text-muted)',
  note_added:          'var(--text-muted)',
}

// ── StatCard ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color, onClick }: {
  label: string; value: number; sub?: string; color?: string; onClick?: () => void
}) {
  const [hovered, setHovered] = React.useState(false)
  return (
    <Card
      onClick={onClick}
      style={{
        padding: 16, cursor: onClick ? 'pointer' : 'default',
        transition: 'transform 0.15s, box-shadow 0.15s',
        transform: hovered && onClick ? 'translateY(-1px)' : 'none',
        boxShadow: hovered && onClick ? 'var(--shadow-md)' : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 500, letterSpacing: '0.02em' }}>{label}</div>
      <div style={{
        fontSize: 28, fontWeight: 700, lineHeight: 1,
        color: color ?? 'var(--text)',
        background: color ? undefined : 'linear-gradient(135deg, var(--primary) 0%, var(--accent) 100%)',
        WebkitBackgroundClip: color ? undefined : 'text',
        WebkitTextFillColor: (color || value === 0) ? undefined : 'transparent',
      }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 5 }}>{sub}</div>}
    </Card>
  )
}

// ── FollowUpCard ──────────────────────────────────────────────────────────────
function FollowUpCard({ items, onNav }: { items: DashboardFollowUp[]; onNav: () => void }) {
  if (items.length === 0) return null
  const now = new Date()
  return (
    <Card style={{ padding: 0, border: '1px solid rgba(217,119,6,0.25)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', background: 'rgba(217,119,6,0.06)', borderBottom: '0.5px solid rgba(217,119,6,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-warning)' }}>Follow-ups Due ({items.length})</span>
        </div>
        <Btn small variant="ghost" onClick={onNav}>View all →</Btn>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {items.slice(0, 5).map((j, i) => {
          const due   = new Date(j.followUpAt)
          const overdue = due < now
          return (
            <div key={j.id} style={{ padding: '9px 14px', borderBottom: i < Math.min(items.length, 5) - 1 ? '0.5px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 7, background: 'rgba(217,119,6,0.1)', color: 'var(--c-warning)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                {j.company.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.company}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.role}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                <StatusBadge status={j.status as JobStatus} />
                <span style={{ fontSize: 9, color: overdue ? 'var(--c-danger)' : 'var(--c-warning)', fontWeight: overdue ? 600 : 400 }}>
                  {overdue ? `${Math.floor((now.getTime() - due.getTime()) / 86400000)}d overdue` : `Due ${fmtDate(j.followUpAt)}`}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── SavedJobsCard ─────────────────────────────────────────────────────────────
function SavedJobsCard({ jobs, onNav }: { jobs: DashboardSavedJob[]; onNav: () => void }) {
  if (jobs.length === 0) return null
  const staleCutoff = new Date()
  staleCutoff.setDate(staleCutoff.getDate() - 7)
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14 }}>📋</span>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Saved — Ready to Apply ({jobs.length})</span>
        </div>
        <Btn small variant="primary" onClick={onNav}>Review & Apply →</Btn>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {jobs.slice(0, 6).map((j, i) => {
          const isStale = new Date(j.createdAt) < staleCutoff
          return (
            <div key={j.id} style={{ padding: '9px 14px', borderBottom: i < Math.min(jobs.length, 6) - 1 ? '0.5px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 7, background: 'rgba(79,70,229,0.08)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                {j.company.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.company}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.role}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <ScorePill score={j.score ?? null} />
                {isStale && <span style={{ fontSize: 9, color: 'var(--c-warning)', background: 'rgba(217,119,6,0.1)', borderRadius: 999, padding: '1px 5px' }}>7d+</span>}
                {j.url && (
                  <a href={j.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                    style={{ fontSize: 10, color: 'var(--primary)', textDecoration: 'none' }}>↗</a>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── PipelineBar ───────────────────────────────────────────────────────────────
function PipelineBar({ pipeline }: { pipeline: Partial<Record<JobStatus, number>> }) {
  const stages: { label: string; key: JobStatus; color: string }[] = [
    { label: 'Saved',     key: 'saved',     color: 'var(--text-muted)' },
    { label: 'Applied',   key: 'applied',   color: 'var(--primary)'   },
    { label: 'In Review', key: 'review',    color: 'var(--c-warning)' },
    { label: 'Interview', key: 'interview', color: 'var(--c-success)' },
    { label: 'Offer',     key: 'offer',     color: 'var(--c-info)'    },
    { label: 'Rejected',  key: 'rejected',  color: 'var(--c-danger)'  },
  ]
  const values = stages.map(s => pipeline[s.key] ?? 0)
  const max    = Math.max(...values, 1)
  const total  = values.reduce((a, b) => a + b, 0)

  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 12, fontWeight: 500 }}>Application Pipeline</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{total} total</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 80 }}>
        {stages.map((s, i) => (
          <div key={s.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: values[i] > 0 ? s.color : 'var(--text-muted)' }}>{values[i]}</span>
            <div style={{ width: '100%', background: 'var(--bg-tertiary)', borderRadius: 4, overflow: 'hidden', height: Math.max(4, (values[i] / max) * 56) }}>
              <div style={{ width: '100%', height: '100%', background: s.color, opacity: values[i] > 0 ? 0.85 : 0.2 }} />
            </div>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.2 }}>{s.label}</span>
          </div>
        ))}
      </div>
      {/* Conversion funnel rate */}
      {(pipeline.applied ?? 0) > 0 && (pipeline.offer ?? 0) > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--border)', fontSize: 10, color: 'var(--text-muted)', display: 'flex', gap: 16 }}>
          <span>Response rate: <strong style={{ color: 'var(--text)' }}>{Math.round(((pipeline.review ?? 0) + (pipeline.interview ?? 0) + (pipeline.offer ?? 0)) / (pipeline.applied ?? 1) * 100)}%</strong></span>
          <span>Offer rate: <strong style={{ color: 'var(--c-info)' }}>{Math.round((pipeline.offer ?? 0) / (pipeline.applied ?? 1) * 100)}%</strong></span>
        </div>
      )}
    </Card>
  )
}

// ── AgentStatusCard ───────────────────────────────────────────────────────────
function AgentStatusCard({ config, onUpdate }: { config: AgentConfig | null; onUpdate: (p: Partial<AgentConfig>) => void }) {
  const toast = useToast()
  const { navigate } = useNav()
  const running = config?.isRunning    ?? false
  const limit   = config?.dailyLimit   ?? 10
  const score   = config?.minMatchScore ?? 75

  async function toggleRunning() {
    const next = !running
    onUpdate({ isRunning: next })
    const { error } = await apiMutate('/api/agent', 'PATCH', { isRunning: next })
    if (error) { onUpdate({ isRunning: running }); toast.error('Error', error) }
    else if (next) toast.success('Agent resumed', 'Scanning for new matches')
    else toast.warning('Agent paused', 'No more auto-actions until resumed')
  }

  return (
    <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>AI Agent</span>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: running ? 'var(--c-success)' : 'var(--text-muted)', boxShadow: running ? '0 0 6px var(--c-success)' : 'none' }} />
          <span style={{ fontSize: 11, color: running ? 'var(--c-success)' : 'var(--text-muted)' }}>{running ? 'Running' : 'Paused'}</span>
        </div>
        <Btn small variant={running ? 'danger' : 'ghost'} onClick={toggleRunning}>{running ? 'Pause' : 'Resume'}</Btn>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Daily limit: {limit} applications</div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Min match score</span>
          <span style={{ fontSize: 11, fontWeight: 500 }}>{score}%</span>
        </div>
        <div style={{ height: 4, background: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${score}%`, height: '100%', background: 'linear-gradient(90deg, var(--primary), var(--accent))', borderRadius: 2 }} />
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingTop: 4, borderTop: '0.5px solid var(--border)' }}>
        {config?.autoApply ? <span style={{ color: 'var(--primary)', fontWeight: 500 }}>Auto-apply on</span> : <span>Manual review required</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Btn small variant="ghost"   style={{ flex: 1 }} onClick={() => navigate('agent')}>Configure</Btn>
        <Btn small variant="primary" style={{ flex: 1 }} onClick={() => navigate('jobs')}>Review Queue</Btn>
      </div>
    </Card>
  )
}

// ── DashboardPage ─────────────────────────────────────────────────────────────
export function DashboardPage() {
  const { navigate } = useNav()
  const { t } = useI18n()
  const { data, loading, error, refetch } = useApi<DashboardData>('/api/dashboard')

  useEffect(() => {
    const id = setInterval(refetch, 30_000)
    return () => clearInterval(id)
  }, [refetch])

  const [agentCfg, setAgentCfg] = useState<AgentConfig | null>(null)
  useEffect(() => { if (data?.agentConfig) setAgentCfg(data.agentConfig) }, [data?.agentConfig])
  function patchAgent(patch: Partial<AgentConfig>) { setAgentCfg(prev => prev ? { ...prev, ...patch } : null) }

  if (loading) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 28, height: 28, border: '2.5px solid rgba(79,70,229,0.15)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading dashboard…</div>
      </div>
    </div>
  )

  if (error) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 10 }}>⚠</div>
        <div style={{ fontSize: 13, color: 'var(--c-danger)', marginBottom: 14 }}>{error}</div>
        <Btn variant="ghost" onClick={refetch}>Retry</Btn>
      </div>
    </div>
  )

  const stats       = data?.stats
  const pipeline    = (data?.pipeline    ?? {}) as Partial<Record<JobStatus, number>>
  const followUps   = data?.followUpsDue ?? []
  const savedJobs   = data?.savedJobs    ?? []
  const recentJobs  = data?.recentJobs   ?? []
  const activity    = data?.activity     ?? []

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)' }}>
      <TopBar title={t('dashboard.title')}>
        <Btn variant="ghost" onClick={() => navigate('search')}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            {t('dashboard.findJobs')}
          </span>
        </Btn>
        <Btn variant="primary" onClick={() => navigate('agent')}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            Run Agent
          </span>
        </Btn>
      </TopBar>

      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Onboarding */}
        {(stats?.total ?? 0) === 0 && (
          <OnboardingChecklist hasResume={data?.hasResume ?? false} hasJobs={false} hasRunAgent={false} />
        )}

        {/* Stats — 5 real metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
          <StatCard label={t('dashboard.saved')} value={stats?.saved ?? 0} color={(stats?.saved ?? 0) > 0 ? 'var(--primary)' : undefined} onClick={() => navigate('jobs')} />
          <StatCard label={t('dashboard.applied')} value={stats?.applied ?? 0} sub={stats?.thisWeek ? `+${stats.thisWeek} this week` : undefined} onClick={() => navigate('jobs')} />
          <StatCard label={t('dashboard.inProgress')} value={stats?.inProgress ?? 0} color={(stats?.inProgress ?? 0) > 0 ? 'var(--c-warning)' : undefined} onClick={() => navigate('jobs')} />
          <StatCard label={t('dashboard.interviews')} value={stats?.interviews ?? 0} color={(stats?.interviews ?? 0) > 0 ? 'var(--c-success)' : undefined} onClick={() => navigate('jobs')} />
          <StatCard label={t('dashboard.offers')} value={stats?.offers ?? 0} color={(stats?.offers ?? 0) > 0 ? 'var(--c-info)' : undefined} onClick={() => navigate('jobs')} />
        </div>

        {/* Action items row */}
        {(followUps.length > 0 || savedJobs.length > 0) && (
          <div style={{ display: 'grid', gridTemplateColumns: followUps.length > 0 && savedJobs.length > 0 ? '1fr 1fr' : '1fr', gap: 16 }}>
            {followUps.length > 0 && <FollowUpCard items={followUps} onNav={() => navigate('jobs')} />}
            {savedJobs.length > 0 && <SavedJobsCard jobs={savedJobs} onNav={() => navigate('jobs')} />}
          </div>
        )}

        {/* Recent Applications + Agent */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16 }}>
          <Card>
            <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '0.5px solid var(--border)' }}>
              <span style={{ fontSize: 12, fontWeight: 500 }}>{t('dashboard.recentApps')}</span>
              <Btn small variant="ghost" onClick={() => navigate('jobs')}>{t('dashboard.viewAll')}</Btn>
            </div>
            {recentJobs.length === 0 ? (
              <div style={{ padding: '24px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('dashboard.noApps')}</div>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-secondary)' }}>
                    {[t('dashboard.cols.company'), t('dashboard.cols.role'), t('dashboard.cols.status'), t('dashboard.cols.date')].map(h => (
                      <th key={h} style={{ padding: '7px 14px', textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, borderBottom: '0.5px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentJobs.map((j, i) => (
                    <tr key={j.id} style={{ borderBottom: i < recentJobs.length - 1 ? '0.5px solid var(--border)' : 'none' }}>
                      <td style={{ padding: '9px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 22, height: 22, borderRadius: 5, background: 'rgba(79,70,229,0.1)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, flexShrink: 0 }}>
                            {(j.logo ?? j.company.slice(0, 2)).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 500 }}>{j.company}</span>
                        </div>
                      </td>
                      <td style={{ padding: '9px 14px', fontSize: 11, color: 'var(--text-muted)' }}>{j.role}</td>
                      <td style={{ padding: '9px 14px' }}><StatusBadge status={j.status} /></td>
                      <td style={{ padding: '9px 14px', fontSize: 10, color: 'var(--text-muted)' }}>{fmtDate(j.appliedAt ?? j.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <AgentStatusCard config={agentCfg} onUpdate={patchAgent} />
        </div>
      </div>
    </div>
  )
}
