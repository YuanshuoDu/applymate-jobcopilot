'use client'

import React from 'react'
import Link from 'next/link'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card } from '@/components/ui'
import { useApi } from '@/lib/hooks'

interface ObservabilityData {
  overall: {
    total: number
    successRate: number
    byFlowUsed: {
      programmatic: number
      patternCache: number
      llm: number
      unknown: number
    }
    avgDurationMs: number
    captchaRate: number
    captchaErrors: number
    last24h: {
      count: number
      successRate: number
    }
  }
  byAts: Array<{
    atsType: string
    count: number
    successRate: number
  }>
}

interface PlatformData {
  users: { total: number; byPlan: { free: number; pro: number; enterprise: number } }
  applies: { total: number }
  deletionRequests: { requested: number; processing: number }
  integrations: {
    ai: { providers: Record<string, boolean> }
    discovery: { adzuna: boolean; rapidapi: boolean }
    oauth: { google: boolean; github: boolean }
    messaging: { resend: boolean }
    infrastructure: { database: boolean; redis: boolean }
    privacy?: { usageAnalytics: boolean; aiTraining: boolean; coverLetterRetention: boolean }
  }
}

const FLOW_COLORS: Record<string, string> = {
  programmatic: 'var(--primary)',
  patternCache: 'var(--c-success)',
  llm: 'var(--c-warning)',
  unknown: 'var(--text-muted)',
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 26, lineHeight: 1, fontWeight: 750, color: 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>{sub}</div>}
    </Card>
  )
}

function Bar({ label, value, max, color, sub }: { label: string; value: number; max: number; color: string; sub?: string }) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 3 : 0) : 0
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, marginBottom: 5 }}>
        <span style={{ color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{sub ? `${value} · ${sub}` : value}</span>
      </div>
      <div style={{ height: 8, background: 'var(--bg-secondary)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: 8, width: `${pct}%`, background: color, borderRadius: 4 }} />
      </div>
    </div>
  )
}

function formatDuration(ms: number) {
  if (!ms) return '0s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

function flowLabel(key: string) {
  return key === 'patternCache' ? 'Pattern cache'
    : key === 'llm' ? 'AI fallback'
    : key === 'programmatic' ? 'Programmatic'
    : 'Unknown'
}

export function ObservabilityPage() {
  const { data, loading, error, refetch } = useApi<ObservabilityData>('/api/admin/observability', { cache: false })
  const { data: platform, loading: platformLoading, error: platformError, refetch: refetchPlatform } = useApi<PlatformData>('/api/admin/v1/platform', { cache: false })
  const overall = data?.overall
  const flowEntries = overall
    ? Object.entries(overall.byFlowUsed).map(([key, value]) => ({ key, value }))
    : []
  const maxFlow = Math.max(...flowEntries.map(f => f.value), 1)
  const maxAts = Math.max(...(data?.byAts ?? []).map(a => a.count), 1)

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg)' }}>
      <TopBar title="Observability">
        <Link href="/admin/plans" style={{ color: 'var(--text-muted)', fontSize: 12, textDecoration: 'none' }}>Manage plans</Link>
        <a href="/admin/users" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', textDecoration: 'none' }}>
          User settings <ExternalLink size={12} aria-hidden="true" />
        </a>
        <Btn small variant="ghost" onClick={refetch}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={13} aria-hidden="true" />
            Refresh
          </span>
        </Btn>
      </TopBar>

      <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {error && (
          <Card style={{ padding: 14, borderColor: 'rgba(220,38,38,0.25)', color: 'var(--c-danger)' }}>
            {error}
          </Card>
        )}
        {platformError && (
          <Card style={{ padding: 14, borderColor: 'rgba(220,38,38,0.25)', color: 'var(--c-danger)' }}>
            {platformError}
          </Card>
        )}

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <StatCard label="Registered users" value={platformLoading ? '…' : String(platform?.users.total ?? 0)} sub={platform ? `${platform.users.byPlan.pro} Pro · ${platform.users.byPlan.enterprise} Team` : undefined} />
          <StatCard label="Deletion queue" value={platformLoading ? '…' : String((platform?.deletionRequests.requested ?? 0) + (platform?.deletionRequests.processing ?? 0))} sub={platform ? `${platform.deletionRequests.processing} processing` : undefined} />
          <StatCard label="Operational applies" value={platformLoading ? '…' : String(platform?.applies.total ?? 0)} sub="All users · operational count" />
        </section>

        <Card style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 14 }}>Platform integrations</h2>
            <Btn small variant="ghost" onClick={() => { refetch(); refetchPlatform() }} disabled={loading || platformLoading}>
              <RefreshCw size={12} aria-hidden="true" /> Refresh all
            </Btn>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {[
              // The built-in route is specifically MiniMax; another configured
              // provider must not make the platform default look healthy.
              ['ApplyMate AI · MiniMax', platform?.integrations.ai.providers.minimax ?? false],
              ['Adzuna', platform?.integrations.discovery.adzuna ?? false],
              ['RapidAPI', platform?.integrations.discovery.rapidapi ?? false],
              ['Google OAuth', platform?.integrations.oauth.google ?? false],
              ['GitHub OAuth', platform?.integrations.oauth.github ?? false],
              ['Resend', platform?.integrations.messaging.resend ?? false],
              ['Database', platform?.integrations.infrastructure.database ?? false],
              ['Redis', platform?.integrations.infrastructure.redis ?? false],
            ].map(([label, ready]) => (
              <span key={String(label)} style={{ fontSize: 10, padding: '4px 8px', borderRadius: 999, background: ready ? 'rgba(5,150,105,0.10)' : 'rgba(220,38,38,0.08)', color: ready ? 'var(--c-success)' : 'var(--c-danger)' }}>
                {String(label)} · {ready ? 'ready' : 'not configured'}
              </span>
            ))}
          </div>
          <div style={{ marginTop: 9, fontSize: 10, color: 'var(--text-muted)' }}>Health is configuration presence only; raw keys, OAuth tokens, and user content are never returned.</div>
          {platform?.integrations.privacy && <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)' }}>Privacy: usage analytics honor candidate consent · AI training pipeline is currently disabled.</div>}
        </Card>

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <StatCard label="Analytics applies" value={loading ? '…' : String(overall?.total ?? 0)} sub="Consented analytics · all time" />
          <StatCard label="Success rate" value={loading ? '…' : `${overall?.successRate ?? 0}%`} sub="Consented submitted / total" />
          <StatCard label="Avg duration" value={loading ? '…' : formatDuration(overall?.avgDurationMs ?? 0)} sub="Consented analytics · all flows" />
          <StatCard
            label="Last 24h"
            value={loading ? '…' : String(overall?.last24h.count ?? 0)}
            sub={`${overall?.last24h.successRate ?? 0}% success · consented analytics`}
          />
        </section>

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
          <Card style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 14 }}>By Flow Type</h2>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{overall?.captchaErrors ?? 0} CAPTCHA · {overall?.captchaRate ?? 0}%</span>
            </div>
            {flowEntries.map(({ key, value }) => (
              <Bar
                key={key}
                label={flowLabel(key)}
                value={value}
                max={maxFlow}
                color={FLOW_COLORS[key] ?? 'var(--primary)'}
              />
            ))}
          </Card>

          <Card style={{ padding: 16 }}>
            <h2 style={{ margin: '0 0 14px', fontSize: 14 }}>By ATS Type</h2>
            {(data?.byAts.length ?? 0) === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No apply results yet.</div>
            ) : data!.byAts.map((ats, idx) => (
              <Bar
                key={ats.atsType}
                label={ats.atsType}
                value={ats.count}
                max={maxAts}
                color={idx % 2 === 0 ? 'var(--primary)' : 'var(--accent)'}
                sub={`${ats.successRate}% success`}
              />
            ))}
          </Card>
        </section>
      </main>
    </div>
  )
}
