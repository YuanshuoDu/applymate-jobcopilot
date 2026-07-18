'use client'

import React from 'react'
import { formatSessionClock } from './session-view-model'

export function ReplayBanner({
  source,
  updatedAt,
  eventCount,
  onBackToLive,
}: {
  source: string
  updatedAt: string
  eventCount: number
  onBackToLive: () => void
}) {
  const sourceLabel = source === 'manual_run' ? 'manual run' : source
  return (
    <div style={{
      display: 'flex',
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      border: '1px solid rgba(79,70,229,0.22)',
      background: 'rgba(79,70,229,0.06)',
      borderRadius: 8,
      padding: '9px 11px',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 750, color: 'var(--primary)' }}>Viewing session replay</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sourceLabel} · {eventCount} events · updated {formatSessionClock(updatedAt)}
        </div>
      </div>
      <button
        onClick={onBackToLive}
        style={{
          flexShrink: 0,
          height: 26,
          borderRadius: 7,
          border: '1px solid rgba(79,70,229,0.24)',
          background: 'var(--bg)',
          color: 'var(--primary)',
          fontSize: 10,
          fontWeight: 700,
          fontFamily: 'inherit',
          cursor: 'pointer',
          padding: '0 10px',
        }}
      >
        Live chat
      </button>
    </div>
  )
}
