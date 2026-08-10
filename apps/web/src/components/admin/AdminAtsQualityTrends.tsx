'use client'

import { useEffect, useState } from 'react'

type Quality = { sources: Array<{ atsType: string; calls: number; successes: number; directCalls: number; directSuccesses: number; avgDuration: number; successRate: number; directSuccessRate: number }> }

export function AdminAtsQualityTrends() {
  const [quality, setQuality] = useState<Quality | null>(null)
  useEffect(() => { void fetch('/api/admin/v1/ats/quality?days=30', { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(payload => setQuality(payload)).catch(() => undefined) }, [])
  return <section className="admin-ai-config"><div className="admin-controls-title"><div><h2>Source quality and Direct Apply</h2><p>Recent application outcomes by ATS source. Direct Apply uses the unattended Worker path.</p></div></div>{!quality ? <p>Loading ATS quality...</p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Source</th><th>Applications</th><th>Success</th><th>Direct Apply</th><th>Direct success</th><th>Avg duration</th></tr></thead><tbody>{quality.sources.length === 0 ? <tr><td colSpan={6}>No application outcomes recorded yet.</td></tr> : quality.sources.map(source => <tr key={source.atsType}><td>{source.atsType}</td><td>{source.calls}</td><td>{source.successRate}%</td><td>{source.directCalls}</td><td>{source.directSuccessRate}%</td><td>{source.avgDuration}ms</td></tr>)}</tbody></table></div>}</section>
}
