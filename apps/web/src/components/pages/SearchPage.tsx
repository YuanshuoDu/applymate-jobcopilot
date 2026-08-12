'use client'

import React from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn } from '@/components/ui'
import { SmartSearch } from '@/components/jobs/SmartSearch'
import { useNav } from '@/lib/nav-context'
import { useI18n } from '@/lib/i18n'

export function SearchPage() {
  const { navigate } = useNav()
  const { t } = useI18n()

  function openApiKeySettings() {
    const url = new URL(window.location.href)
    url.searchParams.set('tab', 'apiKeys')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    navigate('settings')
  }

  return (
    <div className="search-page" style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column' }}>
      <TopBar title={t('search.pageTitle')}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {t('search.aiDesc')}
        </span>
        <Btn variant="toolbar" onClick={() => navigate('jobs')} style={{ marginLeft: 'auto' }}>
          {t('search.viewMyJobs')}
        </Btn>
      </TopBar>

      <div className="search-page-content" style={{ padding: 20, flex: 1, display: 'flex', flexDirection: 'column' }}>
        <SmartSearch onOpenSettings={openApiKeySettings} onJobSaved={() => {
          // Notify JobsPage to refresh when user navigates back
          window.postMessage({ type: 'job-saved' }, window.location.origin)
        }} />
      </div>
    </div>
  )
}
