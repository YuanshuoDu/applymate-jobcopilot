'use client'

import React, { useState, useEffect } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, StatusBadge, useToast } from '@/components/ui'
import type { DashboardData, AgentConfig, JobStatus } from '@/lib/types'
import { useApi, apiMutate, fmtDate, fmtRelative } from '@/lib/hooks'
import { useNav } from '@/lib/nav-context'
import { OnboardingChecklist } from '@/components/onboarding/OnboardingChecklist'

const ACTIVITY_COLORS: Record<string, string> = {
  applied:             '#185FA5',
  interview_scheduled: '#3B6D11',
  offer_received:      '#0E7490',
  rejected:            '#A32D2D',
  email_sent:          '#854F0B',
  agent_action:        '#185FA5',
  resume_tailored:     '#185FA5',
  status_changed:      '#6B7280',
  note_added:          '#6B7280',
}

// ── StatCard ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, delta, deltaPos }: {
  label: string; value: string | number; delta?: string; deltaPos?: boolean
}) {
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, color: 'var(--text)', lineHeight: 1 }}>{value}</div>
      {delta && (
        <div style={{ fontSize: 11, color: deltaPos ? '#3B6D11' : 'var(--text-muted)', marginTop: 6 }}>
          {deltaPos ? '↑' : '→'} {delta}
        </div>
      )}
    </Card>
  )
}

// ── PipelineBar ───────────────────────────────────────────────────────────────
function PipelineBar({ pipeline }: { pipeline: Partial<Record<JobStatus, number>> }) {
  const stages: { label: string; key: JobStatus; color: string }[] = [
    { label: 'Applied',   key: 'applied',   color: '#185FA5' },
    { label: 'In Review', key: 'review',    color: '#854F0B' },
    { label: 'Interview', key: 'interview', color: '#3B6D11' },
    { label: 'Rejected',  key: 'rejected',  color: '#A32D2D' },
    { label: 'Offer',     key: 'offer',     color: '#0E7490' },
  ]
  const values = stages.map(s => pipeline[s.key] ?? 0)
  const max    = Math.max(...values, 1)

  return (
    <Card style={{ padding: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 16 }}>Application Pipeline</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 80 }}>
        {stages.map((s, i) => (
          <div key={s.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: s.color, textAlign: 'center' }}>
              {`${s.label}: ${values[i]}`}
            </span>
            <div style={{ width: '100%', background: 'var(--bg-tertiary)', borderRadius: 4, overflow: 'hidden', height: Math.max(8, (values[i] / max) * 56) }}>
              <div style={{ width: '100%', height: '100%', background: s.color, opacity: 0.8 }} />
            </div>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>{s.label}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ── AgentStatusCard ───────────────────────────────────────────────────────────
function AgentStatusCard({
  config,
  onUpdate,
}: {
  config:   AgentConfig | null
  onUpdate: (patch: Partial<AgentConfig>) => void
}) {
  const toast   = useToast()
  const { navigate } = useNav()
  const running = config?.isRunning  ?? false
  const limit   = config?.dailyLimit ?? 10
  const score   = config?.minMatchScore ?? 75

  async function toggleRunning() {
    const next = !running
    onUpdate({ isRunning: next })
    const { error } = await apiMutate('/api/agent', 'PATCH', { isRunning: next })
    if (error) {
      onUpdate({ isRunning: running })   // rollback
      toast.error('Error', error)
    } else {
      if (next) toast.success('Agent resumed', 'Scanning for new matches')
      else      toast.warning('Agent paused', 'No more auto-actions until resumed')
    }
  }

  return (
    <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>AI Agent</span>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: running ? '#3B6D11' : '#6B7280' }} />
          <span style={{ fontSize: 11, color: running ? '#3B6D11' : 'var(--text-muted)' }}>
            {running ? 'Running' : 'Paused'}
          </span>
        </div>
        <Btn small variant={running ? 'danger' : 'ghost'} onClick={toggleRunning}>
          {running ? 'Pause' : 'Resume'}
        </Btn>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Daily limit: {limit} applications</div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Min match score</span>
          <span style={{ fontSize: 11, fontWeight: 500 }}>{score}%</span>
        </div>
        <div style={{ height: 4, background: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${score}%`, height: '100%', background: '#3B6D11', borderRadius: 2 }} />
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingTop: 4, borderTop: '0.5px solid var(--border)' }}>
        {config?.autoApply
          ? <span style={{ color: '#185FA5', fontWeight: 500 }}>Auto-apply on</span>
          : <span>Manual review required</span>}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <Btn small variant="ghost"   style={{ flex: 1 }} onClick={() => navigate('settings')}>Configure</Btn>
        <Btn small variant="primary" style={{ flex: 1 }} onClick={() => navigate('jobs')}>Review Queue</Btn>
      </div>
    </Card>
  )
}

// ── DashboardPage ─────────────────────────────────────────────────────────────
export function DashboardPage() {
  const { navigate } = useNav()
  const { data, loading, error, refetch } = useApi<DashboardData>('/api/dashboard')

  // Poll for fresh data every 30s
  useEffect(() => {
    const id = setInterval(refetch, 30_000)
    return () => clearInterval(id)
  }, [refetch])

  // Optimistic agent config state (allows toggle without full re-fetch)
  const [agentCfg, setAgentCfg] = useState<AgentConfig | null>(null)
  useEffect(() => {
    if (data?.agentConfig) setAgentCfg(data.agentConfig)
  }, [data?.agentConfig])

  function patchAgent(patch: Partial<AgentConfig>) {
    setAgentCfg(prev => prev ? { ...prev, ...patch } : null)
  }

  // ── Loading ──
  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, border: '2.5px solid rgba(24,95,165,0.2)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading dashboard…</div>
        </div>
      </div>
    )
  }

  // ── Error ──
  if (error) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 10 }}>⚠</div>
          <div style={{ fontSize: 13, color: '#A32D2D', marginBottom: 14 }}>{error}</div>
          <Btn variant="ghost" onClick={refetch}>Retry</Btn>
        </div>
      </div>
    )
  }

  const stats      = data?.stats
  const pipeline   = (data?.pipeline   ?? {}) as Partial<Record<JobStatus, number>>
  const recentJobs = data?.recentJobs  ?? []
  const activity   = data?.activity    ?? []

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)' }}>
      <TopBar title="Dashboard">
        <Btn variant="ghost" onClick={() => navigate('jobs')}>+ Add Job</Btn>
        <Btn variant="primary" onClick={() => navigate('agent')}>▶ Run Agent</Btn>
      </TopBar>

      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Onboarding for new users */}
        {(stats?.total ?? 0) === 0 && (
          <OnboardingChecklist
            hasResume={data?.hasResume ?? false}
            hasJobs={false}
            hasExtension={false}
            hasRunAgent={false}
          />
        )}

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <StatCard
            label="Total Applied"
            value={stats?.applied ?? 0}
            delta={stats?.thisWeek ? `${stats.thisWeek} this week` : undefined}
            deltaPos
          />
          <StatCard label="In Review"  value={stats?.inReview   ?? 0} />
          <StatCard label="Interviews" value={stats?.interviews ?? 0} />
          <StatCard label="Offers"     value={stats?.offers     ?? 0} />
        </div>

        {/* Recent jobs + Agent */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
          <Card>
            <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '0.5px solid var(--border)' }}>
              <span style={{ fontSize: 12, fontWeight: 500 }}>Recent Applications</span>
              <Btn small variant="ghost" onClick={() => navigate('jobs')}>View all</Btn>
            </div>

            {recentJobs.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center' }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>📋</div>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>No applications yet</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 300, margin: '0 auto' }}>
                  Install the Chrome extension to auto-save jobs while browsing LinkedIn, Indeed, or StepStone.
                </div>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-secondary)' }}>
                    {['Company', 'Role', 'Status', 'Date'].map(h => (
                      <th key={h} style={{ padding: '8px 16px', textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, borderBottom: '0.5px solid var(--border)' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentJobs.map((j, i) => (
                    <tr key={j.id} style={{ borderBottom: i < recentJobs.length - 1 ? '0.5px solid var(--border)' : 'none' }}>
                      <td style={{ padding: '10px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 24, height: 24, borderRadius: 5, background: 'rgba(24,95,165,0.1)', color: '#185FA5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, flexShrink: 0 }}>
                            {j.logo ?? j.company.slice(0, 2).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 500 }}>{j.company}</span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-muted)' }}>{j.role}</td>
                      <td style={{ padding: '10px 16px' }}><StatusBadge status={j.status} /></td>
                      <td style={{ padding: '10px 16px', fontSize: 11, color: 'var(--text-muted)' }}>
                        {fmtDate(j.appliedAt ?? j.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <AgentStatusCard config={agentCfg} onUpdate={patchAgent} />
        </div>

        {/* Pipeline bar */}
        <PipelineBar pipeline={pipeline} />

        {/* Activity feed */}
        <Card style={{ padding: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 14 }}>Recent Activity</div>

          {activity.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>
              No activity yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {activity.map((a, i) => (
                <div key={a.id} style={{ display: 'flex', gap: 12, paddingBottom: i < activity.length - 1 ? 12 : 0 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: a.color ?? ACTIVITY_COLORS[a.type] ?? '#6B7280', flexShrink: 0, marginTop: 3 }} />
                    {i < activity.length - 1 && <div style={{ width: 1, flex: 1, background: 'var(--border)', marginTop: 4 }} />}
                  </div>
                  <div style={{ flex: 1, paddingBottom: i < activity.length - 1 ? 4 : 0 }}>
                    <div style={{ fontSize: 12, color: 'var(--text)' }}>{a.text}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      {fmtRelative(a.createdAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
