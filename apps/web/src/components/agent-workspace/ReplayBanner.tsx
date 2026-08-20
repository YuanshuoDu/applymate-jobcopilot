'use client'

import React from 'react'
import { formatSessionClock } from './session-view-model'
import { useI18n } from '@/lib/i18n'

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
  const { t } = useI18n()
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
        <div style={{ fontSize: 11, fontWeight: 750, color: 'var(--primary)' }}>{t('agent.viewReplay')}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sourceLabel} · {eventCount} {t('agent.eventsUpdated')} {formatSessionClock(updatedAt)}
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
        {t('agent.liveChat')}
      </button>
    </div>
  )
}
