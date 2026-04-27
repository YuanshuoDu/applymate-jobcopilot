'use client'

import React, { useState, useEffect, useRef } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, useToast } from '@/components/ui'
import type { AgentConfig, Activity } from '@/lib/types'
import { useApi, apiMutate, fmtRelative } from '@/lib/hooks'

// ── Agent run log types ───────────────────────────────────────────────────────

interface LogEntry {
  type:    'start' | 'job_done' | 'job_skip' | 'job_error' | 'info' | 'done' | 'error'
  message: string
  score?:  number
  time:    Date
}

// ── RunPanel ──────────────────────────────────────────────────────────────────

function RunPanel({ onClose }: { onClose: () => void }) {
  const toast    = useToast()
  const logEndRef = useRef<HTMLDivElement>(null)
  const esRef     = useRef<EventSource | null>(null)

  const [log,      setLog]      = useState<LogEntry[]>([])
  const [running,  setRunning]  = useState(false)
  const [done,     setDone]     = useState(false)
  const [summary,  setSummary]  = useState<{ processed: number; applied: number; skipped: number } | null>(null)

  function addLog(entry: LogEntry) {
    setLog(prev => [...prev, entry])
  }

  // Auto-scroll
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [log])

  function startRun() {
    if (running) return
    setLog([])
    setDone(false)
    setSummary(null)
    setRunning(true)

    const es = new EventSource('/api/agent/run')
    esRef.current = es

    es.addEventListener('start', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'start', message: `🚀 Starting run — ${d.total} saved job${d.total !== 1 ? 's' : ''} to score using resume: "${d.resumeName}"`, time: new Date() })
    })

    es.addEventListener('job_start', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'info', message: `⟳ Analyzing ${d.company} · ${d.role}…`, time: new Date() })
    })

    es.addEventListener('job_done', e => {
      const d = JSON.parse(e.data)
      const applied = d.autoApplied ? ' · ✓ Auto-applied' : ''
      const kws = d.matchedKeywords?.length ? ` [${d.matchedKeywords.slice(0, 3).join(', ')}]` : ''
      addLog({
        type:    d.score >= 70 ? 'job_done' : 'job_skip',
        message: `${d.score >= 80 ? '✦' : d.score >= 60 ? '◆' : '◇'} ${d.company} · ${d.role} — ${d.score}%${kws}${applied}`,
        score:   d.score,
        time:    new Date(),
      })
    })

    es.addEventListener('job_skip', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'job_skip', message: `— ${d.company} · ${d.role} skipped: ${d.reason}`, time: new Date() })
    })

    es.addEventListener('job_error', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'job_error', message: `✗ ${d.company} · ${d.role}: ${d.error}`, time: new Date() })
    })

    es.addEventListener('info', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'info', message: d.message, time: new Date() })
    })

    es.addEventListener('done', e => {
      const d = JSON.parse(e.data)
      setSummary(d)
      addLog({ type: 'done', message: `✓ Done — ${d.processed} scored, ${d.applied} auto-applied, ${d.skipped} skipped`, time: new Date() })
      setRunning(false)
      setDone(true)
      es.close()
      if (d.processed > 0) toast.success('Agent run complete', `Scored ${d.processed} jobs`)
    })

    es.addEventListener('error', e => {
      try {
        const d = JSON.parse((e as MessageEvent).data ?? '{}')
        addLog({ type: 'error', message: `✗ ${d.message ?? 'Agent run failed'}`, time: new Date() })
      } catch {
        addLog({ type: 'error', message: '✗ Connection lost', time: new Date() })
      }
      setRunning(false)
      setDone(true)
      es.close()
    })
  }

  function stopRun() {
    esRef.current?.close()
    esRef.current = null
    setRunning(false)
    setDone(true)
    addLog({ type: 'info', message: '— Run stopped by user', time: new Date() })
  }

  function logColor(entry: LogEntry): string {
    if (entry.type === 'done')       return '#3B6D11'
    if (entry.type === 'error')      return '#A32D2D'
    if (entry.type === 'job_error')  return '#A32D2D'
    if (entry.type === 'job_skip')   return '#6B7280'
    if (entry.type === 'start')      return '#185FA5'
    if (entry.score != null) {
      if (entry.score >= 80) return '#3B6D11'
      if (entry.score >= 60) return '#854F0B'
      return '#6B7280'
    }
    return 'var(--text)'
  }

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>Agent Run</span>
          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#3B6D11', animation: 'pulse 1.5s ease-in-out infinite' }} />
              <span style={{ fontSize: 10, color: '#3B6D11' }}>Running…</span>
            </div>
          )}
          {done && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Finished</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!running && <Btn small variant="primary" onClick={startRun}>{done ? '↻ Run Again' : '▶ Start Run'}</Btn>}
          {running  && <Btn small variant="danger"  onClick={stopRun}>⏹ Stop</Btn>}
          <Btn small variant="ghost" onClick={onClose}>✕</Btn>
        </div>
      </div>

      {/* Summary row */}
      {summary && (
        <div style={{ display: 'flex', gap: 0, borderBottom: '0.5px solid var(--border)' }}>
          {[
            { label: 'Scored',      value: summary.processed, color: '#185FA5' },
            { label: 'Auto-applied',value: summary.applied,   color: '#3B6D11' },
            { label: 'Skipped',     value: summary.skipped,   color: '#6B7280' },
          ].map((s, i) => (
            <div key={s.label} style={{ flex: 1, textAlign: 'center', padding: '8px 0', borderRight: i < 2 ? '0.5px solid var(--border)' : 'none' }}>
              <div style={{ fontSize: 18, fontWeight: 600, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Log */}
      <div style={{ maxHeight: 220, overflowY: 'auto', padding: '8px 14px', background: 'var(--bg)', fontFamily: 'monospace' }}>
        {log.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '12px 0', textAlign: 'center' }}>
            Click ▶ Start Run to score your saved jobs with AI.
          </div>
        ) : log.map((entry, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 3, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0, paddingTop: 2, fontVariantNumeric: 'tabular-nums' }}>
              {entry.time.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span style={{ fontSize: 11, color: logColor(entry), lineHeight: 1.5 }}>{entry.message}</span>
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </Card>
  )
}

// ── Sub-components (pure UI) ──────────────────────────────────────────────────

function Toggle({ value, onChange, label, sub }: { value: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--text)' }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
      </div>
      <div onClick={() => onChange(!value)} style={{ width: 32, height: 18, borderRadius: 9, background: value ? '#185FA5' : 'var(--border)', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
        <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: value ? 16 : 2, transition: 'left 0.2s' }} />
      </div>
    </div>
  )
}

function SliderRow({ label, value, min, max, step = 1, onChange, unit = '' }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; unit?: string
}) {
  return (
    <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: '#185FA5' }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#185FA5', cursor: 'pointer' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{min}{unit}</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{max}{unit}</span>
      </div>
    </div>
  )
}

function ConfigCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', borderBottom: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <span style={{ fontSize: 12, fontWeight: 500 }}>{title}</span>
      </div>
      <div style={{ padding: '0 14px 4px' }}>{children}</div>
    </Card>
  )
}

function PillInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState('')
  function add() {
    if (input.trim()) { onChange([...values, input.trim()]); setInput('') }
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 0' }}>
      {values.map((v, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(24,95,165,0.1)', color: '#185FA5', borderRadius: 999, padding: '2px 8px', fontSize: 11 }}>
          {v}
          <button onClick={() => onChange(values.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#185FA5', fontSize: 11, padding: 0 }}>✕</button>
        </span>
      ))}
      <input value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
        placeholder={placeholder}
        style={{ border: 'none', outline: 'none', fontSize: 11, color: 'var(--text)', background: 'transparent', minWidth: 120, padding: '2px 4px' }} />
    </div>
  )
}

// ── AgentPage ─────────────────────────────────────────────────────────────────

type UiCfg = {
  minScore:          number
  maxPerDay:         number
  autoApply:         boolean
  autoApplyThreshold:number
  requireReview:     boolean
  autoCoverLetter:   boolean
  coverTone:         string
  useTailoredCV:     boolean
  notifyApply:       boolean
  notifyReject:      boolean
  weeklySummary:     boolean
  followUpReminder:  boolean
  followUpDays:      number
  targetRoles:       string[]
  targetLocations:   string[]
  excludeCompanies:  string[]
  priorityCompanies: string[]
  salaryMin:         number
  salaryMax:         number
}

const DEFAULT_CFG: UiCfg = {
  minScore: 70, maxPerDay: 10,
  autoApply: false, autoApplyThreshold: 85,
  requireReview: true,
  autoCoverLetter: true, coverTone: 'Professional',
  useTailoredCV: true,
  notifyApply: true, notifyReject: true, weeklySummary: false, followUpReminder: true,
  followUpDays: 7,
  targetRoles: [], targetLocations: [], excludeCompanies: [],
  priorityCompanies: [],
  salaryMin: 55000, salaryMax: 90000,
}

export function AgentPage() {
  const toast = useToast()

  // Load agent config + activity from API
  const { data: agentData, loading: agentLoading } = useApi<AgentConfig>('/api/agent')
  const { data: activityData } = useApi<Activity[]>('/api/activity?limit=20')

  const [running,      setRunning]      = useState(false)
  const [cfg,          setCfg]          = useState<UiCfg>(DEFAULT_CFG)
  const [saving,       setSaving]       = useState(false)
  const [showRunPanel, setShowRunPanel] = useState(false)

  // Sync API → local state
  useEffect(() => {
    if (!agentData) return
    setRunning(agentData.isRunning)
    setCfg(prev => ({
      ...prev,
      minScore:         agentData.minMatchScore,
      maxPerDay:        agentData.dailyLimit,
      autoApply:        agentData.autoApply,
      requireReview:    agentData.requireApproval,
      targetRoles:      agentData.targetRoles      ?? [],
      targetLocations:  agentData.targetLocations  ?? [],
      excludeCompanies: agentData.excludeCompanies ?? [],
    }))
  }, [agentData])

  function set<K extends keyof UiCfg>(k: K, v: UiCfg[K]) {
    setCfg(c => ({ ...c, [k]: v }))
  }

  async function toggleRunning() {
    const next = !running
    setRunning(next)
    const { error } = await apiMutate('/api/agent', 'PATCH', { isRunning: next })
    if (error) {
      setRunning(!next)
      toast.error('Error', error)
    } else {
      if (next) toast.success('Agent resumed', 'Scanning for new matches')
      else      toast.warning('Agent paused', 'No more auto-actions until resumed')
    }
  }

  async function saveConfig() {
    setSaving(true)
    const { error } = await apiMutate('/api/agent', 'PATCH', {
      isRunning:        running,
      dailyLimit:       cfg.maxPerDay,
      minMatchScore:    cfg.minScore,
      autoApply:        cfg.autoApply,
      requireApproval:  cfg.requireReview,
      targetLocations:  cfg.targetLocations,
      targetRoles:      cfg.targetRoles,
      excludeCompanies: cfg.excludeCompanies,
    })
    setSaving(false)
    if (error) toast.error('Error', error)
    else       toast.success('Settings saved', 'Agent will use updated configuration')
  }

  const activities = activityData ?? []

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column' }}>
      <TopBar title="AI Agent">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: running ? '#3B6D11' : '#6B7280' }} />
          <span style={{ fontSize: 11, color: running ? '#3B6D11' : 'var(--text-muted)', fontWeight: 500 }}>
            {running ? 'Running' : 'Paused'}
          </span>
        </div>
        <Btn variant="ghost" onClick={() => setShowRunPanel(s => !s)}>
          {showRunPanel ? '✕ Close Log' : '▶ Run Now'}
        </Btn>
        <Btn variant={running ? 'danger' : 'primary'} onClick={toggleRunning}>
          {running ? '⏸ Pause Agent' : '▶ Resume Agent'}
        </Btn>
      </TopBar>

      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Status card */}
        <Card style={{ padding: 16 }}>
          {agentLoading ? (
            <div style={{ textAlign: 'center', padding: '16px 0', fontSize: 12, color: 'var(--text-muted)' }}>Loading agent status…</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 0, marginBottom: 14 }}>
                {[
                  { label: 'Daily limit',    value: String(cfg.maxPerDay) },
                  { label: 'Min score',      value: `${cfg.minScore}%`   },
                  { label: 'Auto-apply',     value: cfg.autoApply ? 'On' : 'Off' },
                  { label: 'Manual review',  value: cfg.requireReview ? 'On' : 'Off' },
                ].map((s, i) => (
                  <div key={s.label} style={{ textAlign: 'center', padding: '0 16px', borderRight: i < 3 ? '0.5px solid var(--border)' : 'none' }}>
                    <div style={{ fontSize: 20, fontWeight: 500, color: 'var(--text)' }}>{s.value}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Min match score</span>
                  <span style={{ fontSize: 11, fontWeight: 500 }}>{cfg.minScore}%</span>
                </div>
                <div style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${cfg.minScore}%`, height: '100%', background: '#185FA5', borderRadius: 3, transition: 'width 0.3s' }} />
                </div>
              </div>

              {/* Activity log */}
              <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: 10, maxHeight: 140, overflowY: 'auto' }}>
                {activities.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>No activity yet</div>
                ) : activities.map(a => (
                  <div key={a.id} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                      {new Date(a.createdAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text)' }}>{a.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        {/* Run panel — shown when user clicks ▶ Run Now */}
        {showRunPanel && <RunPanel onClose={() => setShowRunPanel(false)} />}

        {/* Config grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ConfigCard title="Job Matching Rules">
              <SliderRow label="Minimum match score" value={cfg.minScore} min={40} max={100} onChange={v => set('minScore', v)} unit="%" />
              <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Target roles</div>
                <PillInput values={cfg.targetRoles} onChange={v => set('targetRoles', v)} placeholder="Add role…" />
              </div>
              <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Target locations</div>
                <PillInput values={cfg.targetLocations} onChange={v => set('targetLocations', v)} placeholder="Add location…" />
              </div>
              <SliderRow label="Min salary" value={cfg.salaryMin} min={20000} max={150000} step={5000} onChange={v => set('salaryMin', v)} unit="€" />
              <SliderRow label="Max salary" value={cfg.salaryMax} min={20000} max={150000} step={5000} onChange={v => set('salaryMax', v)} unit="€" />
            </ConfigCard>

            <ConfigCard title="Application Limits">
              <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12 }}>Max applications / day</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => set('maxPerDay', Math.max(1, cfg.maxPerDay - 1))} style={{ width: 24, height: 24, borderRadius: 4, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', cursor: 'pointer', fontSize: 14 }}>−</button>
                  <span style={{ fontSize: 13, fontWeight: 500, minWidth: 24, textAlign: 'center' }}>{cfg.maxPerDay}</span>
                  <button onClick={() => set('maxPerDay', Math.min(50, cfg.maxPerDay + 1))} style={{ width: 24, height: 24, borderRadius: 4, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', cursor: 'pointer', fontSize: 14 }}>+</button>
                </div>
              </div>
              <Toggle label="Skip if already applied" sub="Deduplication across all sources" value={true} onChange={() => {}} />
              <Toggle label="Apply in working hours only" sub="09:00 – 18:00 CET" value={true} onChange={() => {}} />
            </ConfigCard>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ConfigCard title="Auto-Apply Settings">
              <Toggle label="Auto-apply when match ≥ threshold" sub="Applies automatically without review" value={cfg.autoApply} onChange={v => set('autoApply', v)} />
              {cfg.autoApply && <SliderRow label="Auto-apply threshold" value={cfg.autoApplyThreshold} min={50} max={100} onChange={v => set('autoApplyThreshold', v)} unit="%" />}
              <Toggle label="Require manual review below threshold" sub="Jobs below threshold need your approval" value={cfg.requireReview} onChange={v => set('requireReview', v)} />
              <Toggle label="Auto-generate cover letter" value={cfg.autoCoverLetter} onChange={v => set('autoCoverLetter', v)} />
              <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12 }}>Cover letter tone</span>
                <select value={cfg.coverTone} onChange={e => set('coverTone', e.target.value)}
                  style={{ fontSize: 11, padding: '3px 6px', border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
                  {['Professional', 'Confident', 'Concise'].map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <Toggle label="Use tailored CV per role" sub="AI generates a custom variant for each application" value={cfg.useTailoredCV} onChange={v => set('useTailoredCV', v)} />
            </ConfigCard>

            <ConfigCard title="Notifications">
              <Toggle label="Notify on auto-apply"  value={cfg.notifyApply}      onChange={v => set('notifyApply', v)} />
              <Toggle label="Notify on rejection"    value={cfg.notifyReject}     onChange={v => set('notifyReject', v)} />
              <Toggle label="Weekly summary email"   value={cfg.weeklySummary}    onChange={v => set('weeklySummary', v)} />
              <Toggle label="Follow-up reminders"    value={cfg.followUpReminder} onChange={v => set('followUpReminder', v)} />
              {cfg.followUpReminder && (
                <div style={{ padding: '8px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Remind after (days)</span>
                  <input type="number" value={cfg.followUpDays} min={1} max={30} onChange={e => set('followUpDays', Number(e.target.value))}
                    style={{ width: 48, padding: '3px 6px', fontSize: 11, border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }} />
                </div>
              )}
            </ConfigCard>

            <ConfigCard title="AI Model">
              <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12 }}>Active model</span>
                <select style={{ fontSize: 11, padding: '3px 6px', border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
                  <option>Claude Sonnet 4.6</option>
                  <option>GPT-4o</option>
                  <option>Gemini 1.5 Pro</option>
                  <option>Mistral Large</option>
                  <option>Custom endpoint…</option>
                </select>
              </div>
              <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12 }}>Channel</span>
                <select style={{ fontSize: 11, padding: '3px 6px', border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
                  <option>Direct API</option>
                  <option>OpenRouter</option>
                  <option>Azure OpenAI</option>
                  <option>Ollama (local)</option>
                </select>
              </div>
              <div style={{ padding: '8px 0' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>API Key</div>
                <input type="password" placeholder="sk-…" style={{ width: '100%', marginTop: 4, padding: '5px 8px', fontSize: 11, border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none', boxSizing: 'border-box' }} />
              </div>
            </ConfigCard>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <ConfigCard title="Companies to Avoid">
            <div style={{ padding: '10px 0' }}>
              <PillInput values={cfg.excludeCompanies} onChange={v => set('excludeCompanies', v)} placeholder="Add company…" />
            </div>
          </ConfigCard>
          <ConfigCard title="Priority Companies (Always Apply)">
            <div style={{ padding: '10px 0' }}>
              <PillInput values={cfg.priorityCompanies} onChange={v => set('priorityCompanies', v)} placeholder="Add company…" />
            </div>
          </ConfigCard>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingBottom: 8 }}>
          <Btn variant="ghost" onClick={() => { setCfg(DEFAULT_CFG); toast.info('Reset', 'Settings restored to defaults') }}>Reset to defaults</Btn>
          <Btn variant="primary" onClick={saveConfig} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Btn>
        </div>
      </div>
    </div>
  )
}
