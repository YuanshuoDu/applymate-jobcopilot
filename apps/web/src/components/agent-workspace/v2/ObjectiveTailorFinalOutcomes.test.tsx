import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA as schema } from '@jobcopilot/agent-protocol'
import { ObjectiveTailorFinalOutcomes } from './ObjectiveTailorFinalOutcomes'

const sidecar = { schemaVersion: schema, slots: [
  { ordinal: 1, status: 'ready' }, { ordinal: 2, status: 'needs_revision' }, { ordinal: 3, status: 'stale' },
] }

describe('ObjectiveTailorFinalOutcomes', () => {
  it('renders only bounded ordinal statuses with localized labels', () => {
    const en = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={{ objectiveTailorFinalOutcomes: sidecar }} lang="en" />)
    const zh = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={{ objectiveTailorFinalOutcomes: sidecar }} lang="zh" />)
    expect(en).toContain('Job 1: Ready')
    expect(en).toContain('Job 2: Needs revision')
    expect(en).toContain('Job 3: Out of date')
    expect(zh).toContain('职位 1: 已就绪')
    expect(en).not.toMatch(/artifact|digest|jobId|taskId|PRIVATE/iu)
  })

  it('hides malformed sidecars and does not render private extra fields', () => {
    const bad = { ...sidecar, privateProof: 'PRIVATE_PROOF' }
    const html = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={{ objectiveTailorFinalOutcomes: bad }} lang="en" />)
    expect(html).toBe('')
    expect(html).not.toContain('PRIVATE_PROOF')
  })
})
