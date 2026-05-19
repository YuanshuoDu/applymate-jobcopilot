'use client'

import React from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { SmartSearch } from '@/components/jobs/SmartSearch'
import { useNav } from '@/lib/nav-context'
import { useI18n } from '@/lib/i18n'

export function SearchPage() {
  const { navigate } = useNav()
  const { t } = useI18n()

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column' }}>
      <TopBar title={t('search.pageTitle')}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {t('search.aiDesc')}
        </span>
        <button
          onClick={() => navigate('jobs')}
          style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--primary)', background: 'none', border: '0.5px solid rgba(79,70,229,0.30)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
          {t('search.viewMyJobs')}
        </button>
      </TopBar>

      <div style={{ padding: 20, flex: 1, display: 'flex', flexDirection: 'column' }}>
        <SmartSearch onJobSaved={() => {
          // Notify JobsPage to refresh when user navigates back
          window.postMessage({ type: 'job-saved' }, window.location.origin)
        }} />
      </div>
    </div>
  )
}
