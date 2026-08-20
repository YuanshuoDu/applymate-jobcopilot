'use client'

import React from 'react'
import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'

interface AgentHealth {
  successRate: number
  captchaRate: number
  avgDurationMs: number
  patternCacheRate: number
  last24hRuns: number
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
        {!loading && !error && (
          <div style={{ marginTop: 8, fontSize: 9, color: 'var(--text-muted)' }}>
            {t('agent.last24h')} · {data?.last24hRuns ?? 0} runs
          </div>
        )}
      </div>
    </div>
  )
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
