'use client'

import { useEffect, useState } from 'react'
import { fetchWithTimeout } from '@/lib/hooks'

type Usage = { summary: { calls: number; errors: number; errorRate: number; costUsd: number }; trend: Array<{ day: string; calls: number; errors: number; cost: number; avgLatency: number }>; providers: Array<{ provider: string; model: string; calls: number; errors: number; cost: number; avgLatency: number }> }

export function AdminAiUsageTrends() {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void fetchWithTimeout('/api/admin/v1/ai/usage?days=30', { cache: 'no-store' }).then(async response => {
      const payload = await response.json().catch(() => null) as Usage | { error?: string } | null
      if (!response.ok) throw new Error(payload && 'error' in payload ? payload.error ?? 'Unable to load AI usage trends.' : 'Unable to load AI usage trends.')
      return payload as Usage
    }).then(payload => { if (active) setUsage(payload) }).catch(loadError => { if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load AI usage trends.') })
    return () => { active = false }
  }, [])
  if (!usage) return <section className="admin-ai-config"><p role="status">{error || 'Loading AI usage trends...'}</p></section>
  const maxCalls = Math.max(...usage.trend.map(item => item.calls), 1)
  return <section className="admin-ai-config"><div className="admin-controls-title"><div><h2>AI cost and reliability trends</h2><p>Last 30 days from provider responses, including failed calls and measured latency.</p></div></div><div className="admin-metric-grid"><div className="admin-metric"><span>Calls</span><strong>{usage.summary.calls}</strong></div><div className="admin-metric"><span>Estimated cost</span><strong>${usage.summary.costUsd.toFixed(4)}</strong></div><div className="admin-metric"><span>Error rate</span><strong>{usage.summary.errorRate}%</strong></div></div><div className="admin-trend-grid">{usage.trend.length === 0 ? <p>No AI calls recorded yet.</p> : usage.trend.map(item => <div className="admin-trend-row" key={item.day}><strong>{new Date(item.day).toLocaleDateString()}</strong><span className="admin-trend-bar"><i style={{ width: `${Math.max(3, item.calls / maxCalls * 100)}%` }} /></span><span>{item.calls} calls · {item.avgLatency}ms · ${item.cost.toFixed(4)}</span></div>)}</div><div className="admin-table-wrap" style={{ marginTop: 18 }}><table className="admin-table"><thead><tr><th>Provider / model</th><th>Calls</th><th>Errors</th><th>Cost</th><th>Latency</th></tr></thead><tbody>{usage.providers.map(item => <tr key={`${item.provider}:${item.model}`}><td>{item.provider} · {item.model}</td><td>{item.calls}</td><td>{item.errors}</td><td>${item.cost.toFixed(4)}</td><td>{item.avgLatency}ms</td></tr>)}</tbody></table></div></section>
}
