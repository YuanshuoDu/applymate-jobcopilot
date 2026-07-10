'use client'

import type { RunSummary } from './live-run-types'

export function AgentUnifiedStreamHeader({
  running,
  summary,
  approvalRequired,
}: {
  running: boolean
  summary: RunSummary | null
  approvalRequired: boolean
}) {
  return (
    <div style={{ padding: '12px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg)', flexShrink: 0 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 750, color: 'var(--text)', lineHeight: 1.2 }}>Berlin SWE Auto-Apply</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
          Agent workspace{summary ? ` · ${summary.processed} scored · ${summary.applied} applied` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        {running && <span style={{ fontSize: 10, color: 'var(--primary)', fontWeight: 700 }}>Running</span>}
        {approvalRequired && <span style={{ fontSize: 10, color: '#d97706', fontWeight: 700 }}>Approval required</span>}
      </div>
    </div>
  )
}
