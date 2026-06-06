'use client'

import React, { useMemo, useState } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card } from '@/components/ui'
import { fmtDate, useApi } from '@/lib/hooks'

interface AgentRunHistory {
  id: string
  createdAt: string
  durationMs: number
  stagesCompleted: number
  jobsFound: number
  status: string
  report: AgentRunReport | null
  log: AgentRunEvent[] | null
}

interface AgentRunReport {
  processed?: number
  applied?: number
  pending?: number
  skipped?: number
  failed?: number
  durationMs?: number
}

interface AgentRunEvent {
  event: string
  at: string
  data: Record<string, unknown> | string | number | boolean | null
}

const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  completed: { label: 'Completed', color: '#16a34a', bg: 'rgba(22,163,74,0.12)' },
  partial:   { label: 'Partial',   color: '#ca8a04', bg: 'rgba(202,138,4,0.12)' },
  failed:    { label: 'Failed',    color: '#dc2626', bg: 'rgba(220,38,38,0.12)' },
}

const LOG_EVENTS = new Set([
  'agent_plan',
  'agent_reflect',
  'orchestrator_thinking',
  'orchestrator_decision',
  'orchestrator_retry',
  'role_start',
  'role_done',
  'stage_start',
  'stage_done',
  'job_start',
  'job_done',
  'job_skip',
  'job_error',
  'info',
  'done',
  'error',
])

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS[status] ?? { label: status, color: '#64748b', bg: 'rgba(100,116,139,0.12)' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      borderRadius: 999, padding: '3px 9px',
      background: cfg.bg, color: cfg.color,
      fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.color, flexShrink: 0 }} />
      {cfg.label}
    </span>
  )
}

function Duration({ ms }: { ms: number }) {
  const safe = Math.max(0, ms)
  const sec = Math.round(safe / 1000)
  if (sec < 60) return <span>{sec}s</span>
  const min = Math.floor(sec / 60)
  return <span>{min}m {sec % 60}s</span>
}

function dataLabel(data: AgentRunEvent['data']) {
  if (!data || typeof data !== 'object') return typeof data === 'string' ? data : ''
  const row = data as Record<string, unknown>
  const pieces = [
    row.stage ? `stage=${row.stage}` : '',
    row.role ? `role=${row.role}` : '',
    row.label ? String(row.label) : '',
    row.message ? String(row.message) : '',
    row.company && row.role ? `${row.company} / ${row.role}` : '',
    typeof row.count === 'number' ? `count=${row.count}` : '',
    typeof row.discovered === 'number' ? `discovered=${row.discovered}` : '',
    typeof row.durationMs === 'number' ? `${Math.round(row.durationMs / 1000)}s` : '',
  ].filter(Boolean)
  return pieces.length > 0 ? pieces.join(' | ') : JSON.stringify(data)
}

function ReportStrip({ report }: { report: AgentRunReport | null }) {
  const items = [
    ['Processed', report?.processed ?? 0],
    ['Applied', report?.applied ?? 0],
    ['Pending', report?.pending ?? 0],
    ['Skipped', report?.skipped ?? 0],
    ['Failed', report?.failed ?? 0],
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(80px, 1fr))', gap: 8, marginTop: 12 }}>
      {items.map(([label, value]) => (
        <div key={label} style={{
          border: '1px solid var(--border)', borderRadius: 8,
          padding: '8px 10px', background: 'var(--bg-secondary)',
        }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0 }}>{label}</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>{value}</div>
        </div>
      ))}
    </div>
  )
}

function EventLog({ events }: { events: AgentRunEvent[] }) {
  const visible = events.filter(e => LOG_EVENTS.has(e.event))
  if (visible.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>No detailed event log captured for this run.</div>
  }
  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--border)' }}>
      {visible.map((e, idx) => (
        <div key={`${e.at}-${e.event}-${idx}`} style={{
          display: 'grid', gridTemplateColumns: '120px 150px 1fr',
          gap: 10, padding: '9px 0', borderBottom: '1px solid var(--border)',
          alignItems: 'start',
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <span style={{
            width: 'fit-content', maxWidth: 150,
            borderRadius: 999, padding: '2px 8px',
            background: 'rgba(79,70,229,0.10)', color: 'var(--primary)',
            fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {e.event}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, wordBreak: 'break-word', minWidth: 0 }}>
            {dataLabel(e.data)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function AgentHistoryPage() {
  const { data, loading, error, refetch } = useApi<{ runs: AgentRunHistory[] }>('/api/agent/history')
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const runs = useMemo(() => data?.runs ?? [], [data])
  const totals = useMemo(() => ({
    runs: runs.length,
    jobs: runs.reduce((sum, run) => sum + run.jobsFound, 0),
    applied: runs.reduce((sum, run) => sum + (run.report?.applied ?? 0), 0),
    failed: runs.filter(run => run.status === 'failed').length,
  }), [runs])

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, border: '2.5px solid rgba(79,70,229,0.18)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading agent history...</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: '#A32D2D', marginBottom: 14 }}>{error}</div>
          <Btn variant="ghost" onClick={refetch}>Retry</Btn>
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)' }}>
      <TopBar title="Agent History">
        <Btn variant="ghost" onClick={refetch}>Refresh</Btn>
      </TopBar>

      <div style={{ padding: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(120px, 1fr))', gap: 12, marginBottom: 16 }}>
          {[
            ['Runs', totals.runs],
            ['Jobs Found', totals.jobs],
            ['Applied', totals.applied],
            ['Failed Runs', totals.failed],
          ].map(([label, value]) => (
            <Card key={label} style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, marginBottom: 6 }}>{label}</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)' }}>{value}</div>
            </Card>
          ))}
        </div>

        {runs.length === 0 ? (
          <Card style={{ padding: '46px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--text)' }}>No agent runs yet</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 380, margin: '0 auto' }}>
              Completed and failed agent pipeline runs will appear here after the agent is started.
            </div>
          </Card>
        ) : (
          <Card>
            <div style={{
              display: 'grid', gridTemplateColumns: '1.4fr 110px 120px 120px 120px 36px',
              padding: '10px 16px', borderBottom: '1px solid var(--border)',
              background: 'var(--bg-secondary)', borderRadius: '8px 8px 0 0',
            }}>
              {['Date', 'Duration', 'Stages', 'Jobs Found', 'Status', ''].map(h => (
                <div key={h} style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0 }}>{h}</div>
              ))}
            </div>

            {runs.map((run, idx) => {
              const open = openRunId === run.id
              return (
                <div key={run.id} style={{ borderBottom: idx < runs.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <button
                    type="button"
                    onClick={() => setOpenRunId(open ? null : run.id)}
                    style={{
                      width: '100%', border: 'none', background: open ? 'var(--bg-secondary)' : 'transparent',
                      display: 'grid', gridTemplateColumns: '1.4fr 110px 120px 120px 120px 36px',
                      padding: '13px 16px', alignItems: 'center', cursor: 'pointer',
                      textAlign: 'left', color: 'var(--text)', fontFamily: 'inherit',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{fmtDate(run.createdAt)}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {new Date(run.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <div style={{ fontSize: 12 }}><Duration ms={run.durationMs} /></div>
                    <div style={{ fontSize: 12 }}>{run.stagesCompleted}</div>
                    <div style={{ fontSize: 12 }}>{run.jobsFound}</div>
                    <StatusBadge status={run.status} />
                    <div style={{ fontSize: 16, color: 'var(--text-muted)', textAlign: 'right' }}>{open ? '-' : '+'}</div>
                  </button>

                  {open && (
                    <div style={{ padding: '2px 16px 16px', background: 'var(--bg-secondary)' }}>
                      <ReportStrip report={run.report} />
                      <EventLog events={run.log ?? []} />
                    </div>
                  )}
                </div>
              )
            })}
          </Card>
        )}
      </div>
    </div>
  )
}
