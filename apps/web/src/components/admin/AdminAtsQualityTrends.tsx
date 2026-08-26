'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'

type Quality = { sources: Array<{ atsType: string; calls: number; successes: number; directCalls: number; directSuccesses: number; avgDuration: number; successRate: number; directSuccessRate: number }> }

export function AdminAtsQualityTrends() {
  const { t } = useI18n()
  const [quality, setQuality] = useState<Quality | null>(null)
  const [error, setError] = useState('')
  async function load() {
    setQuality(null)
    setError('')
    try {
      const response = await fetch('/api/admin/v1/ats/quality?days=30', { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as Quality | { error?: string } | null
      if (!response.ok || !payload || !('sources' in payload)) throw new Error(payload && 'error' in payload ? payload.error : undefined)
      setQuality(payload)
    } catch {
      setError(t('atsQuality.loadFailed'))
    }
  }
  useEffect(() => { void load() }, [])
  return <section className="admin-ai-config"><div className="admin-controls-title"><div><h2>{t('atsQuality.title')}</h2><p>{t('atsQuality.description')}</p></div></div>{error ? <div className="admin-alert ats-inline-alert">{error}<button className="admin-secondary" type="button" onClick={() => void load()}>{t('common.retry')}</button></div> : !quality ? <p>{t('atsQuality.loading')}</p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('atsQuality.source')}</th><th>{t('atsQuality.applications')}</th><th>{t('atsQuality.success')}</th><th>{t('atsQuality.directApply')}</th><th>{t('atsQuality.directSuccess')}</th><th>{t('atsQuality.avgDuration')}</th></tr></thead><tbody>{quality.sources.length === 0 ? <tr><td colSpan={6}>{t('atsQuality.empty')}</td></tr> : quality.sources.map(source => <tr key={source.atsType}><td>{source.atsType}</td><td>{source.calls}</td><td>{source.successRate}%</td><td>{source.directCalls}</td><td>{source.directSuccessRate}%</td><td>{source.avgDuration}ms</td></tr>)}</tbody></table></div>}</section>
}
