import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useApi } from '@/lib/hooks'
import { HealthStrip } from './HealthStrip'

vi.mock('@/lib/hooks', () => ({ useApi: vi.fn() }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

describe('HealthStrip', () => {
  it('shows budget, compaction, and uncertain states without guessing success', () => {
    vi.mocked(useApi).mockReturnValue({
      data: {
        successRate: 90, captchaRate: 0, avgDurationMs: 1_000, patternCacheRate: 50, last24hRuns: 4,
        budget: { used: 85, limit: 100, unit: 'tokens', warning: 'Only 15 tokens remain.' },
        compaction: { status: 'failed', beforeTokens: 1_200, afterTokens: null, message: 'Previous context retained.' },
        uncertain: [{ id: 'u1', label: 'Provider result', detail: 'Awaiting confirmation' }, { id: 'u2', label: 'Artifact', detail: 'Version is stale' }],
      }, loading: false, error: null, refetch: vi.fn(),
    } as never)
    const html = renderToStaticMarkup(<HealthStrip />)
    expect(html).toContain('Near limit')
    expect(html).toContain('failed')
    expect(html).toContain('2 needs review')
    expect(html).toContain('Previous context retained.')
  })
})
