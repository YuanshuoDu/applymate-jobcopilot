'use client'

import React, { useState, useEffect } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card } from '@/components/ui'
import { useApi, fmtDate, apiMutate } from '@/lib/hooks'

// Types

interface ApplyHistoryResult {
  id: number
  status: string
  mode: string
  atsType: string | null
  flowUsed: string | null
  error: string | null
  durationMs: number | null
  createdAt: string
  jobId: string
  company: string
  role: string
  jobUrl: string | null
}

// Status config

const APPLY_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  submitted: { label: 'Submitted',   color: '#22c55e', bg: 'rgba(34,197,94,0.12)'  },
  manual:    { label: 'Manual',      color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  failed:    { label: 'Failed',      color: '#ef4444', bg: 'rgba(239,68,68,0.12)'  },
  'dry-run': { label: 'Dry Run',     color: '#6b7280', bg: 'rgba(107,114,128,0.12)'},
}

function ApplyBadge({ status }: { status: string }) {
  const cfg = APPLY_STATUS[status] ?? { label: status, color: '#6b7280', bg: 'rgba(107,114,128,0.12)' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: cfg.bg, color: cfg.color,
      borderRadius: 999, padding: '2px 8px',
      fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, flexShrink: 0 }} />
      {cfg.label}
    </span>
  )
}

function DurationCell({ ms }: { ms: number | null }) {
  if (ms == null) return <span style={{ color: 'var(--text-muted)' }}>--</span>
  const sec = Math.round(ms / 1000)
  if (sec < 60) return <span>{sec}s</span>
  return <span>{Math.floor(sec / 60)}m {sec % 60}s</span>
}

function StatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{
      flex: 1,
      background: 'var(--bg)',
      border: '0.5px solid var(--border)',
      borderRadius: 10,
      padding: '12px 16px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color, lineHeight: 1 }}>{value}</div>
    </div>
  )
}

// Page

export function ApplyHistoryPage() {
  const { data, loading, error, refetch } = useApi<{ results: ApplyHistoryResult[] }>('/api/apply-results')
  const [retrying, setRetrying] = useState<Record<number, boolean>>({})
  const [stats, setStats] = useState<{ total: number; submitted: number; manual: number; failed: number; dryRun: number; avgDurationMs: number | null } | null>(null)

  useEffect(() => {
    fetch('/api/apply-results/stats')
      .then(r => r.json())
      .then(d => setStats(d.stats ?? null))
      .catch(() => {})
  }, [data])

  async function handleRetry(jobId: string, resultId: number) {
    setRetrying(r => ({ ...r, [resultId]: true }))
    try {
      await apiMutate(`/api/jobs/${jobId}/auto-apply`, 'POST')
    } finally {
      setRetrying(r => ({ ...r, [resultId]: false }))
      setTimeout(refetch, 3000)
    }
  }

  const results = data?.results ?? []

  // Loading
  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, border: '2.5px solid rgba(24,95,165,0.2)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading apply history...</div>
        </div>
      </div>
    )
  }

  // Error
  if (error) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 10 }}>!</div>
          <div style={{ fontSize: 13, color: '#A32D2D', marginBottom: 14 }}>{error}</div>
          <Btn variant="ghost" onClick={refetch}>Retry</Btn>
        </div>
      </div>
    )
  }

  const successRate = stats && stats.total > 0
    ? Math.round((stats.submitted / (stats.total - stats.dryRun)) * 100) + '%'
    : '\u2014'
  const avgTime = stats?.avgDurationMs != null
    ? Math.round(stats.avgDurationMs / 1000) + 's'
    : '\u2014'

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)' }}>
      <TopBar title="Apply History">
        <Btn variant="ghost" onClick={refetch}>Refresh</Btn>
      </TopBar>

      <div style={{ padding: 20 }}>

        {/* Stats bar */}
        {stats && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
            <StatCard label="Total" value={stats.total} color="var(--text)" />
            <StatCard label="Submitted" value={stats.submitted} color="#22c55e" />
            <StatCard label="Manual" value={stats.manual} color="#f59e0b" />
            <StatCard label="Failed" value={stats.failed} color="#ef4444" />
            <StatCard label="Success rate" value={successRate} color="#22c55e" />
            <StatCard label="Avg time" value={avgTime} color="var(--text)" />
          </div>
        )}

        {/* Empty state */}
        {results.length === 0 ? (
          <Card style={{ padding: '48px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>No results</div>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6, color: 'var(--text)' }}>No apply history yet</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 360, margin: '0 auto' }}>
              Apply results will appear here after you use Auto Apply or the AI Agent to submit applications.
            </div>
          </Card>
        ) : (
          <Card>
            {/* Table header */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1.6fr 1.6fr 120px 130px 90px 80px 130px',
              padding: '10px 16px', borderBottom: '0.5px solid var(--border)',
              background: 'var(--bg-secondary)', borderRadius: '12px 12px 0 0',
            }}>
              {['Company', 'Role', 'Status', 'ATS', 'Flow', 'Duration', 'Date'].map(h => (
                <div key={h} style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.3px' }}>{h}</div>
              ))}
              <div />
            </div>

            {/* Rows */}
            {results.map((r, i) => {
              const hasError = r.status === 'failed' || r.status === 'manual'
              const flowLabel = r.flowUsed === 'programmatic' ? 'Pre-programmed' : r.flowUsed === 'llm' ? 'AI agent' : (r.flowUsed ?? '--')

              return (
                <div key={r.id} style={{
                  display: 'grid', gridTemplateColumns: '1.6fr 1.6fr 120px 130px 90px 80px 130px',
                  padding: '12px 16px', alignItems: 'center',
                  borderBottom: i < results.length - 1 ? '0.5px solid var(--border)' : 'none',
                }}>
                  {/* Company */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: 5,
                      background: 'rgba(24,95,165,0.1)', color: '#185FA5',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 9, fontWeight: 700, flexShrink: 0,
                    }}>
                      {r.company.slice(0, 2).toUpperCase()}
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{r.company}</span>
                  </div>

                  {/* Role */}
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.role}>
                    {r.role}
                  </div>

                  {/* Status */}
                  <ApplyBadge status={r.status} />

                  {/* ATS */}
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {r.atsType ?? '--'}
                  </span>

                  {/* Flow */}
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {flowLabel}
                  </span>

                  {/* Duration */}
                  <DurationCell ms={r.durationMs} />

                  {/* Date + Retry */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 70 }}>
                      {fmtDate(r.createdAt)}
                    </span>
                    {hasError && (
                      <Btn
                        small
                        variant="danger"
                        disabled={!!retrying[r.id]}
                        onClick={() => handleRetry(r.jobId, r.id)}
                      >
                        {retrying[r.id] ? '...' : 'Retry'}
                      </Btn>
                    )}
                  </div>
                </div>
              )
            })}
          </Card>
        )}

        {/* Error details for errored rows */}
        {results.filter(r => r.error).length > 0 && (
          <div style={{ marginTop: 12 }}>
            {results.filter(r => r.error).map(r => (
              <div key={`err-${r.id}`} style={{
                fontSize: 11, color: '#ef4444', padding: '4px 0',
                display: 'flex', gap: 8, alignItems: 'flex-start',
              }}>
                <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{r.company} / {r.role}:</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {r.error!.length > 200 ? r.error!.slice(0, 200) + '...' : r.error}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
