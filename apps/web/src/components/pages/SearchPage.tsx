'use client'

import React from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { SmartSearch } from '@/components/jobs/SmartSearch'
import { useNav } from '@/lib/nav-context'

export function SearchPage() {
  const { navigate } = useNav()

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column' }}>
      <TopBar title="Search Jobs">
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          AI 聚合搜索 · 自动选源 · 去重排序
        </span>
        <button
          onClick={() => navigate('jobs')}
          style={{ marginLeft: 'auto', fontSize: 11, color: '#185FA5', background: 'none', border: '0.5px solid rgba(24,95,165,0.3)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
          View My Jobs →
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
