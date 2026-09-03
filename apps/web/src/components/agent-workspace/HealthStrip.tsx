'use client'

import React from 'react'
import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import { budgetViewState } from './agent-workspace-projection'
import type { AgentWorkspaceBudget, AgentWorkspaceCompaction, AgentWorkspaceUncertainty } from './session-view-model'

export interface AgentHealth {
  successRate: number
  captchaRate: number
  avgDurationMs: number
  patternCacheRate: number
  last24hRuns: number
  budget?: AgentWorkspaceBudget
  compaction?: AgentWorkspaceCompaction
  uncertain?: AgentWorkspaceUncertainty[]
}

function formatDuration(ms: number) {
  if (ms <= 0) return '0s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

export function HealthStrip() {
  const { data, loading, error } = useApi<AgentHealth>('/api/agent/health')
  const { t } = useI18n()

  return (
    <div style={{ padding: '0 10px 12px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0, fontWeight: 700, marginBottom: 6 }}>
        {t('agent.sessionQuality')}
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', padding: 9 }}>
        {loading ? (
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('agent.loadingHealth')}</div>
        ) : error ? (
          <div title={error} style={{ fontSize: 10, color: 'var(--c-danger)' }}>{t('agent.healthUnavailable')}</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <HealthMetric label={t('agent.success')} value={`${data?.successRate ?? 0}%`} good />
            <HealthMetric label="CAPTCHA" value={`${data?.captchaRate ?? 0}%`} warn={(data?.captchaRate ?? 0) > 0} />
            <HealthMetric label={t('agent.average')} value={formatDuration(data?.avgDurationMs ?? 0)} />
            <HealthMetric label={t('agent.cache')} value={`${data?.patternCacheRate ?? 0}%`} />
          </div>
        )}
        {!loading && !error && <OperationalState budget={data?.budget} compaction={data?.compaction} uncertain={data?.uncertain ?? []} />}
        {!loading && !error && (
          <div style={{ marginTop: 8, fontSize: 9, color: 'var(--text-muted)' }}>
            {t('agent.last24h')} · {data?.last24hRuns ?? 0} runs
          </div>
        )}
      </div>
    </div>
  )
}

function OperationalState({ budget, compaction, uncertain }: { budget?: AgentWorkspaceBudget; compaction?: AgentWorkspaceCompaction; uncertain: AgentWorkspaceUncertainty[] }) {
  const budgetState = budget ? budgetViewState(budget.used, budget.limit) : 'unknown'
  const budgetText = !budget ? 'Not reported' : budgetState === 'exhausted' ? 'Exhausted' : budgetState === 'near_limit' ? 'Near limit' : budgetState === 'ok' ? 'Within budget' : 'Unknown'
  const compactionText = compaction?.status ?? 'Not reported'
  const uncertaintyText = uncertain.length === 0 ? 'None reported' : `${uncertain.length} needs review`
  return (
    <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--border)', display: 'grid', gap: 6 }}>
      <StatusLine label="Budget" value={budgetText} tone={budgetState === 'ok' ? 'good' : budgetState === 'unknown' ? 'muted' : 'warn'} />
      <StatusLine label="Compaction" value={compactionText} tone={compaction?.status === 'failed' ? 'danger' : compaction?.status === 'running' ? 'warn' : 'muted'} />
      <StatusLine label="Uncertain" value={uncertaintyText} tone={uncertain.length > 0 ? 'warn' : 'muted'} />
      {compaction?.message && <div style={{ fontSize: 9, lineHeight: 1.4, color: compaction.status === 'failed' ? '#d97706' : 'var(--text-muted)' }}>{compaction.message}</div>}
    </div>
  )
}

function StatusLine({ label, value, tone }: { label: string; value: string; tone: 'good' | 'warn' | 'danger' | 'muted' }) {
  const color = tone === 'good' ? 'var(--c-success)' : tone === 'danger' ? 'var(--c-danger)' : tone === 'warn' ? '#d97706' : 'var(--text-muted)'
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 9 }}><span style={{ color: 'var(--text-muted)' }}>{label}</span><span style={{ color, fontWeight: 700 }}>{value}</span></div>
}

function HealthMetric({ label, value, good = false, warn = false }: {
  label: string
  value: string
  good?: boolean
  warn?: boolean
}) {
  const color = good ? 'var(--c-success)' : warn ? '#d97706' : 'var(--text)'
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 750, color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
    </div>
  )
}
