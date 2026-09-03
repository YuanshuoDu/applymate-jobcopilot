import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionStatusCards } from './SessionStatusCards'

describe('SessionStatusCards', () => {
  it('renders artifact version/hash freshness and operational status', () => {
    const html = renderToStaticMarkup(<SessionStatusCards
      artifacts={[{ id: 'artifact-1', title: 'Resume draft', type: 'resume', version: 4, hash: 'sha256:abc', stale: true, staleReason: 'New answer changed the material.' }]}
      budget={{ used: 30, limit: 100, unit: 'tokens' }}
      compaction={{ status: 'running', beforeTokens: 2_000, afterTokens: null }}
      uncertain={[{ id: 'u1', label: 'Approval receipt', detail: 'Refresh required', severity: 'medium' }]}
    />)
    expect(html).toContain('Resume draft')
    expect(html).toContain('Stale — review required')
    expect(html).toContain('sha256:abc')
    expect(html).toContain('Within budget')
    expect(html).toContain('running')
    expect(html).toContain('Refresh required')
  })
})
