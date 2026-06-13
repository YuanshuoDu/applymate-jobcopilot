'use client'

import React from 'react'
import { RefreshCw } from 'lucide-react'
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
  const { data, loading, error, refetch } = useApi<ObservabilityData>('/api/admin/observability')
  const overall = data?.overall
  const flowEntries = overall
    ? Object.entries(overall.byFlowUsed).map(([key, value]) => ({ key, value }))
    : []
  const maxFlow = Math.max(...flowEntries.map(f => f.value), 1)
  const maxAts = Math.max(...(data?.byAts ?? []).map(a => a.count), 1)

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg)' }}>
      <TopBar title="Observability">
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

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <StatCard label="Total applies" value={loading ? '…' : String(overall?.total ?? 0)} sub="All time" />
          <StatCard label="Success rate" value={loading ? '…' : `${overall?.successRate ?? 0}%`} sub="Submitted / total" />
          <StatCard label="Avg duration" value={loading ? '…' : formatDuration(overall?.avgDurationMs ?? 0)} sub="Across all flows" />
          <StatCard
            label="Last 24h"
            value={loading ? '…' : String(overall?.last24h.count ?? 0)}
            sub={`${overall?.last24h.successRate ?? 0}% success`}
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
