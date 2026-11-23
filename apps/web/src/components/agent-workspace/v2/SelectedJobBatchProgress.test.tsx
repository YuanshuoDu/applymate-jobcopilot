import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }))

import { I18nProvider } from '@/lib/i18n'
import type { SelectedJobBatchWorkbenchModel } from '@/lib/agent/session/selected-job-batch-workbench-read-model'
import { SelectedJobBatchProgress } from './SelectedJobBatchProgress'

const ref = { artifactId: 'private-artifact-id', version: 2, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}` }

function model(): SelectedJobBatchWorkbenchModel {
  return {
    sessionId: 'session-1', turnId: 'turn-1',
    source: { sessionId: 'session-1', sourceTurnId: 'source-turn', rootTaskId: 'source-root', graphItemId: 'source-graph', graphRevision: 3 },
    graph: { itemId: 'batch-graph', rootTaskId: 'batch-root', revision: 4 }, status: 'partial',
    jobs: [
      { slotId: 'slot-1', jobId: 'private-job-one', company: 'Beta', role: 'Engineer', status: 'completed',
        writer: { status: 'completed', artifactRef: ref }, reviewer: { status: 'completed', reviewStatus: 'passed' } },
      { slotId: 'slot-2', jobId: 'private-job-two', company: 'Alpha', role: 'Analyst', status: 'failed',
        writer: { status: 'failed' }, reviewer: { status: 'pending' } },
    ],
  }
}

describe('SelectedJobBatchProgress', () => {
  it('renders per-job progress in shortlist order and keeps saved drafts closed until explicitly opened', () => {
    const html = renderToStaticMarkup(<I18nProvider><SelectedJobBatchProgress model={model()} /></I18nProvider>)
    expect(html.indexOf('Beta · Engineer')).toBeLessThan(html.indexOf('Alpha · Analyst'))
    expect(html).toContain('Batch preparation: Partial')
    expect(html).toContain('Job: Completed')
    expect(html).toContain('Review: Completed · Passed')
    expect(html).toContain('Writing: Failed')
    expect(html).toContain('Draft preparation only. No application is submitted.')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('View saved draft: Engineer · Beta')
    expect(html).not.toContain('private-job-one')
    expect(html).not.toContain('private-artifact-id')
    expect(html).not.toContain(ref.contentHash)
    expect(html).not.toContain(ref.sourceDigest)
    expect(html).not.toContain('data-selected-job-draft')
  })

  it('localizes the status labels and disables artifact opening when no validated ref is available', () => {
    const unsafe = model()
    const malformed = { ...unsafe, jobs: unsafe.jobs.map((job, index) => index === 0
      ? { ...job, writer: { ...job.writer, artifactRef: { ...ref, privateOwnerId: 'other' } } }
      : job) } as unknown as SelectedJobBatchWorkbenchModel
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => 'zh' })
    try {
      const html = renderToStaticMarkup(<I18nProvider><SelectedJobBatchProgress model={malformed} /></I18nProvider>)
      expect(html).toContain('所选职位进度')
      expect(html).toContain('批次准备状态: 部分完成')
      expect(html).toContain('职位: 已完成')
      expect(html).toContain('审核: 已完成 · 通过')
      expect(html).toContain('已完成；草稿暂不可读取')
      expect(html).not.toContain('查看草稿: Engineer · Beta')
      expect(html).not.toContain('data-selected-job-draft')
    } finally { vi.unstubAllGlobals() }
  })
})
