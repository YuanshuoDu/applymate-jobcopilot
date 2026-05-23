'use client'

import React, { useState, useEffect, useRef } from 'react'
import { TopBar }           from '@/components/layout/TopBar'
import { Btn, Card, useToast } from '@/components/ui'
import type { AgentConfig, Activity } from '@/lib/types'
import { useApi, apiMutate, fmtRelative } from '@/lib/hooks'
import { MODEL_CATALOGUE, PROVIDER_LABELS, type AiConfig } from '@/lib/model-router'

// ── Stage definitions ─────────────────────────────────────────────────────────

const STAGES = [
  { key: 'scout',   icon: '🔍', label: '侦察' },
  { key: 'analyze', icon: '🤖', label: '分析' },
  { key: 'prepare', icon: '📝', label: '准备' },
  { key: 'gate',    icon: '🚦', label: '审核' },
  { key: 'execute', icon: '🚀', label: '执行' },
  { key: 'audit',   icon: '✅', label: '验收' },
] as const

type StageKey = typeof STAGES[number]['key']
type StageStatus = 'idle' | 'running' | 'done' | 'error'

// ── Log entry ─────────────────────────────────────────────────────────────────

interface LogEntry {
  type:    'start' | 'stage_start' | 'stage_done' | 'job_done' | 'job_skip' | 'job_error' | 'info' | 'done' | 'error'
  message: string
  score?:  number
  time:    Date
}

// ── Stage progress bar ────────────────────────────────────────────────────────

function StagePipeline({
  statuses,
  current,
}: {
  statuses: Record<StageKey, StageStatus>
  current: StageKey | null
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '12px 14px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)' }}>
      {STAGES.map((s, i) => {
        const st = statuses[s.key]
        const isCurrent = current === s.key
        const color = st === 'done' ? 'var(--c-success)' : isCurrent ? 'var(--primary)' : st === 'error' ? 'var(--c-danger)' : 'var(--text-muted)'
        return (
          <React.Fragment key={s.key}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 48 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: st === 'done' ? 'rgba(5,150,105,0.10)' : isCurrent ? 'rgba(79,70,229,0.12)' : 'var(--bg-tertiary)',
                border: `1.5px solid ${color}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, transition: 'all 0.2s',
                animation: isCurrent ? 'pulse 1.5s ease-in-out infinite' : 'none',
              }}>
                {st === 'done' ? '✓' : s.icon}
              </div>
              <span style={{ fontSize: 9, color, fontWeight: isCurrent ? 600 : 400 }}>{s.label}</span>
            </div>
            {i < STAGES.length - 1 && (
              <div style={{ flex: 1, height: 1.5, background: st === 'done' ? 'var(--c-success)' : 'var(--border)', transition: 'background 0.3s', margin: '0 2px', marginBottom: 14 }} />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

// ── RunPanel ──────────────────────────────────────────────────────────────────

function RunPanel({ onClose }: { onClose: () => void }) {
  const toast     = useToast()
  const logEndRef = useRef<HTMLDivElement>(null)
  const esRef     = useRef<EventSource | null>(null)

  const [log,      setLog]      = useState<LogEntry[]>([])
  const [running,  setRunning]  = useState(false)
  const [done,     setDone]     = useState(false)
  const [summary,  setSummary]  = useState<{ processed: number; applied: number; pending: number; skipped: number; failed: number } | null>(null)
  const [stageStatuses, setStageStatuses] = useState<Record<StageKey, StageStatus>>(
    () => Object.fromEntries(STAGES.map(s => [s.key, 'idle'])) as Record<StageKey, StageStatus>
  )
  const [currentStage, setCurrentStage] = useState<StageKey | null>(null)

  function addLog(entry: LogEntry) { setLog(prev => [...prev, entry]) }

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [log])

  function startRun() {
    if (running) return
    setLog([])
    setDone(false)
    setSummary(null)
    setCurrentStage(null)
    setStageStatuses(Object.fromEntries(STAGES.map(s => [s.key, 'idle'])) as Record<StageKey, StageStatus>)
    setRunning(true)

    // Fire-and-forget: trigger job discovery before pipeline runs
    fetch('/api/agent/scout', { method: 'POST' })
      .then(r => console.log('[agent-run] Scout:', r.status === 200 ? 'queued' : r.status === 409 ? 'skipped (cooldown)' : 'error ' + r.status))
      .catch(() => console.log('[agent-run] Scout: unavailable'))

    const es = new EventSource('/api/agent/run')
    esRef.current = es

    es.addEventListener('stage_start', e => {
      const d = JSON.parse(e.data) as { stage: StageKey; label: string }
      setCurrentStage(d.stage)
      setStageStatuses(prev => ({ ...prev, [d.stage]: 'running' }))
      addLog({ type: 'stage_start', message: `▶ ${d.label}`, time: new Date() })
    })

    es.addEventListener('stage_done', e => {
      const d = JSON.parse(e.data) as { stage: StageKey; count?: number; applied?: number; pending?: number }
      setStageStatuses(prev => ({ ...prev, [d.stage]: 'done' }))
      const detail = d.count != null ? ` (${d.count})` : d.applied != null ? ` applied: ${d.applied}, pending: ${d.pending ?? 0}` : ''
      addLog({ type: 'stage_done', message: `  ✓ ${d.stage}${detail}`, time: new Date() })
    })

    es.addEventListener('start', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'start', message: `🚀 Starting pipeline — ${d.total} saved job${d.total !== 1 ? 's' : ''} queued`, time: new Date() })
    })

    es.addEventListener('job_start', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'info', message: `  ⟳ Scoring ${d.company} · ${d.role}…`, time: new Date() })
    })

    es.addEventListener('job_done', e => {
      const d = JSON.parse(e.data)
      const applied = d.autoApplied ? ' · ✓ Applied' : ''
      const kws = d.matchedKeywords?.length ? ` [${d.matchedKeywords.slice(0, 3).join(', ')}]` : ''
      addLog({
        type:    d.score >= 70 ? 'job_done' : 'job_skip',
        message: `  ${d.score >= 80 ? '✦' : d.score >= 60 ? '◆' : '◇'} ${d.company} · ${d.role} — ${d.score}%${kws}${applied}`,
        score:   d.score,
        time:    new Date(),
      })
    })

    es.addEventListener('job_skip', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'job_skip', message: `  — ${d.company} · ${d.role}: ${d.reason}`, time: new Date() })
    })

    es.addEventListener('job_error', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'job_error', message: `  ✗ ${d.company} · ${d.role}: ${d.error}`, time: new Date() })
    })

    es.addEventListener('info', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'info', message: d.message, time: new Date() })
    })

    es.addEventListener('done', e => {
      const d = JSON.parse(e.data)
      setSummary(d)
      setCurrentStage(null)
      addLog({
        type: 'done',
        message: `✓ Pipeline complete — ${d.processed} scored, ${d.applied} applied, ${d.pending} pending review, ${d.skipped} skipped`,
        time: new Date(),
      })
      setRunning(false)
      setDone(true)
      es.close()
      toast.success(
        'Agent run complete',
        d.processed > 0
          ? `Scored ${d.processed} jobs, applied to ${d.applied}. New jobs from Scout may appear in Jobs list.`
          : 'Pipeline done. Check Jobs — Scout may have added new discoveries.'
      )
    })

    es.addEventListener('error', e => {
      try {
        const d = JSON.parse((e as MessageEvent).data ?? '{}')
        addLog({ type: 'error', message: `✗ ${d.message ?? 'Agent run failed'}`, time: new Date() })
      } catch {
        addLog({ type: 'error', message: '✗ Connection lost', time: new Date() })
      }
      setCurrentStage(null)
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
    setCurrentStage(null)
    addLog({ type: 'info', message: '— Run stopped by user', time: new Date() })
  }

  function logColor(entry: LogEntry): string {
    if (entry.type === 'done')       return 'var(--c-success)'
    if (entry.type === 'error')      return 'var(--c-danger)'
    if (entry.type === 'job_error')  return 'var(--c-danger)'
    if (entry.type === 'job_skip')   return 'var(--text-muted)'
    if (entry.type === 'stage_start')return 'var(--primary)'
    if (entry.type === 'stage_done') return 'var(--c-success)'
    if (entry.type === 'start')      return 'var(--primary)'
    if (entry.score != null) {
      if (entry.score >= 80) return 'var(--c-success)'
      if (entry.score >= 60) return 'var(--c-warning)'
      return 'var(--text-muted)'
    }
    return 'var(--text)'
  }

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>Agent Pipeline</span>
          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--c-success)', boxShadow: '0 0 6px var(--c-success)', animation: 'pulse 1.5s ease-in-out infinite' }} />
              <span style={{ fontSize: 10, color: 'var(--c-success)' }}>Running…</span>
            </div>
          )}
          {done && !running && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Finished</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!running && <Btn small variant="primary" onClick={startRun}>{done ? '↻ Run Again' : '▶ Start Run'}</Btn>}
          {running   && <Btn small variant="danger"  onClick={stopRun}>⏹ Stop</Btn>}
          <Btn small variant="ghost" onClick={onClose}>✕</Btn>
        </div>
      </div>

      {/* Stage progress bar */}
      <StagePipeline statuses={stageStatuses} current={currentStage} />

      {/* Summary row */}
      {summary && (
        <div style={{ display: 'flex', gap: 0, borderBottom: '0.5px solid var(--border)' }}>
          {[
            { label: 'Scored',   value: summary.processed, color: 'var(--primary)'   },
            { label: 'Applied',  value: summary.applied,   color: 'var(--c-success)' },
            { label: 'Review',   value: summary.pending,   color: 'var(--c-warning)' },
            { label: 'Skipped',  value: summary.skipped,   color: 'var(--text-muted)' },
          ].map((s, i) => (
            <div key={s.label} style={{ flex: 1, textAlign: 'center', padding: '8px 0', borderRight: i < 3 ? '0.5px solid var(--border)' : 'none' }}>
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
            Click ▶ Start Run to launch the 6-stage pipeline.
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
      <div onClick={() => onChange(!value)} style={{ width: 32, height: 18, borderRadius: 9, background: value ? 'var(--primary)' : 'var(--border)', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
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
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--primary)' }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }} />
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
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(79,70,229,0.10)', color: 'var(--primary)', borderRadius: 999, padding: '2px 8px', fontSize: 11 }}>
          {v}
          <button onClick={() => onChange(values.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontSize: 11, padding: 0 }}>✕</button>
        </span>
      ))}
      <input value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
        placeholder={placeholder}
        style={{ border: 'none', outline: 'none', fontSize: 11, color: 'var(--text)', background: 'transparent', minWidth: 120, padding: '2px 4px' }} />
    </div>
  )
}

// ── Model selector (from ModelRouter catalogue) ───────────────────────────────

function ModelSelector({ value, onChange }: {
  value: { provider: string; model: string }
  onChange: (v: { provider: string; model: string }) => void
}) {
  const byProvider = MODEL_CATALOGUE.reduce<Record<string, typeof MODEL_CATALOGUE>>((acc, m) => {
    if (!acc[m.provider]) acc[m.provider] = []
    acc[m.provider].push(m)
    return acc
  }, {})

  return (
    <select
      value={`${value.provider}::${value.model}`}
      onChange={e => {
        const [provider, model] = e.target.value.split('::')
        onChange({ provider, model })
      }}
      style={{ fontSize: 11, padding: '3px 6px', border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}
    >
      {Object.entries(byProvider).map(([provider, models]) => (
        <optgroup key={provider} label={PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider}>
          {models.map(m => (
            <option key={`${m.provider}::${m.model}`} value={`${m.provider}::${m.model}`}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

// ── AgentPage ─────────────────────────────────────────────────────────────────

type UiCfg = {
  minScore:          number
  maxPerDay:         number
  autoApply:         boolean
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
  aiProvider:        string
  aiModel:           string
  aiApiKey:          string
}

const DEFAULT_CFG: UiCfg = {
  minScore: 70, maxPerDay: 10,
  autoApply: false, requireReview: true,
  autoCoverLetter: false, coverTone: 'professional', useTailoredCV: false,
  notifyApply: true, notifyReject: true, weeklySummary: false, followUpReminder: true,
  followUpDays: 7,
  targetRoles: [], targetLocations: [], excludeCompanies: [], priorityCompanies: [],
  salaryMin: 55000, salaryMax: 90000,
  aiProvider: 'anthropic', aiModel: 'claude-sonnet-4-6', aiApiKey: '',
}

export function AgentPage() {
  const toast = useToast()

  const { data: agentData, loading: agentLoading } = useApi<AgentConfig>('/api/agent')
  const { data: activityData } = useApi<Activity[]>('/api/activity?limit=20')

  const [running,      setRunning]      = useState(false)
  const [cfg,          setCfg]          = useState<UiCfg>(DEFAULT_CFG)
  const [saving,       setSaving]       = useState(false)
  const [showRunPanel, setShowRunPanel] = useState(false)

  useEffect(() => {
    if (!agentData) return
    setRunning(agentData.isRunning)
    setCfg(prev => ({
      ...prev,
      minScore:          agentData.minMatchScore,
      maxPerDay:         agentData.dailyLimit,
      autoApply:         agentData.autoApply,
      requireReview:     agentData.requireApproval,
      autoCoverLetter:   (agentData as any).autoCoverLetter  ?? false,
      coverTone:         (agentData as any).coverTone        ?? 'professional',
      useTailoredCV:     (agentData as any).useTailoredCV    ?? false,
      targetRoles:       agentData.targetRoles               ?? [],
      targetLocations:   agentData.targetLocations           ?? [],
      excludeCompanies:  agentData.excludeCompanies          ?? [],
      priorityCompanies: (agentData as any).priorityCompanies ?? [],
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

    // Save agent config
    const { error } = await apiMutate('/api/agent', 'PATCH', {
      isRunning:         running,
      dailyLimit:        cfg.maxPerDay,
      minMatchScore:     cfg.minScore,
      autoApply:         cfg.autoApply,
      requireApproval:   cfg.requireReview,
      targetLocations:   cfg.targetLocations,
      targetRoles:       cfg.targetRoles,
      excludeCompanies:  cfg.excludeCompanies,
      priorityCompanies: cfg.priorityCompanies,
      autoCoverLetter:   cfg.autoCoverLetter,
      coverTone:         cfg.coverTone,
      useTailoredCV:     cfg.useTailoredCV,
      model:             `${cfg.aiProvider}/${cfg.aiModel}`,
    })

    // Save AI config to user preferences
    if (!error && cfg.aiProvider && cfg.aiModel) {
      const aiConfig: Partial<AiConfig> = {
        provider: cfg.aiProvider as AiConfig['provider'],
        model:    cfg.aiModel,
        ...(cfg.aiApiKey.trim() ? { apiKey: cfg.aiApiKey.trim() } : {}),
      }
      await apiMutate('/api/me/ai-config', 'POST', aiConfig)
    }

    setSaving(false)
    if (error) toast.error('Error', error)
    else       toast.success('Settings saved', 'Agent will use updated configuration')
  }

  const activities = activityData ?? []

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column' }}>
      <TopBar title="AI Agent">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: running ? 'var(--c-success)' : 'var(--text-muted)', boxShadow: running ? '0 0 6px var(--c-success)' : 'none' }} />
          <span style={{ fontSize: 11, color: running ? 'var(--c-success)' : 'var(--text-muted)', fontWeight: 500 }}>
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
                  { label: 'Daily limit',   value: String(cfg.maxPerDay) },
                  { label: 'Min score',     value: `${cfg.minScore}%` },
                  { label: 'Auto-apply',    value: cfg.autoApply ? 'On' : 'Off' },
                  { label: 'Cover letter',  value: cfg.autoCoverLetter ? 'On' : 'Off' },
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
                  <div style={{ width: `${cfg.minScore}%`, height: '100%', background: 'linear-gradient(90deg, var(--primary), var(--accent))', borderRadius: 3, transition: 'width 0.3s' }} />
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
                    <span style={{ fontSize: 11, color: a.color ?? 'var(--text)' }}>{a.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        {/* Run panel */}
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
              <Toggle label="Skip if already processed today" sub="Deduplication across all sources" value={true} onChange={() => {}} />
            </ConfigCard>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ConfigCard title="Auto-Apply Settings">
              <Toggle label="Auto-apply when match ≥ min score" sub="Applies automatically without review" value={cfg.autoApply} onChange={v => set('autoApply', v)} />
              <Toggle label="Require manual review" sub="Jobs go to Review column before applying" value={cfg.requireReview} onChange={v => set('requireReview', v)} />
              <Toggle label="Auto-generate cover letter" sub="AI writes a tailored cover letter per job" value={cfg.autoCoverLetter} onChange={v => set('autoCoverLetter', v)} />
              {cfg.autoCoverLetter && (
                <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12 }}>Cover letter tone</span>
                  <select value={cfg.coverTone} onChange={e => set('coverTone', e.target.value)}
                    style={{ fontSize: 11, padding: '3px 6px', border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
                    <option value="professional">Professional</option>
                    <option value="confident">Confident</option>
                    <option value="concise">Concise</option>
                  </select>
                </div>
              )}
              <Toggle label="Use tailored CV per role" sub="Logs missing keywords for each application" value={cfg.useTailoredCV} onChange={v => set('useTailoredCV', v)} />
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
                <ModelSelector
                  value={{ provider: cfg.aiProvider, model: cfg.aiModel }}
                  onChange={v => { set('aiProvider', v.provider); set('aiModel', v.model) }}
                />
              </div>
              <div style={{ padding: '8px 0' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>API Key (optional — uses server key if empty)</div>
                <input type="password" value={cfg.aiApiKey} onChange={e => set('aiApiKey', e.target.value)} placeholder="sk-…"
                  style={{ width: '100%', marginTop: 4, padding: '5px 8px', fontSize: 11, border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none', boxSizing: 'border-box' }} />
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
