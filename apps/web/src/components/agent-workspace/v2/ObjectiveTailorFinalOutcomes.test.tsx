import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA as schema } from '@jobcopilot/agent-protocol'
import { buildObjectiveApplicationReviewSelection, objectiveReviewCommandKeyForIntent, ObjectiveTailorFinalOutcomes } from './ObjectiveTailorFinalOutcomes'

const sidecar = { schemaVersion: schema, slots: [
  { ordinal: 1, status: 'ready' }, { ordinal: 2, status: 'needs_revision' }, { ordinal: 3, status: 'ready' },
] }
const manifest = { schemaVersion: 'agent-harness.v2.task-graph-sources.v1', graphRevision: 9, sources: [
  { sourceKey: 'src_' + 'A'.repeat(43), nodeIndex: 0, role: 'scout', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' },
] }
const reviewProps = { sessionId: 'session-1', sourceTurnId: 'source-turn-1', rootTaskId: 'root-task-1' }

describe('ObjectiveTailorFinalOutcomes', () => {
  it('renders only bounded ordinal statuses with localized labels', () => {
    const content = { objectiveTailorFinalOutcomes: sidecar, taskGraphSources: manifest }
    const en = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={content} lang="en" {...reviewProps} />)
    const zh = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={content} lang="zh" {...reviewProps} />)
    expect(en).toContain('Job 1: Ready')
    expect(en).toContain('Job 2: Needs revision')
    expect(en).toContain('Job 3: Ready')
    expect(zh).toContain('职位 1: 已就绪')
    expect(en.match(/type="checkbox"/g)).toHaveLength(2)
    expect(en.match(/Request application review/g)).toHaveLength(1)
    expect(en).not.toMatch(/artifact|digest|jobId|taskId|PRIVATE/iu)
  })

  it('builds one sorted multi-slot intent and keeps failed retries stable until a new intent', () => {
    const selection = buildObjectiveApplicationReviewSelection({ sourceTurnId: 'source-turn-1', rootTaskId: 'root-task-1',
      graphItemId: 'task-graph-' + 'b'.repeat(64), graphRevision: 9, slotOrdinals: [3, 1] })
    expect(selection?.slotOrdinals).toEqual([1, 3])
    const keys = new Map<string, string>()
    const first = objectiveReviewCommandKeyForIntent(keys, 'intent:1,3')
    expect(objectiveReviewCommandKeyForIntent(keys, 'intent:1,3')).toBe(first)
    keys.delete('intent:1,3')
    expect(objectiveReviewCommandKeyForIntent(keys, 'intent:1,3')).not.toBe(first)
  })

  it('hides the grouped request when the completed source identity is absent', () => {
    const html = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={{ objectiveTailorFinalOutcomes: sidecar, taskGraphSources: manifest }} lang="en" />)
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('Request application review')
  })

  it('hides malformed sidecars and does not render private extra fields', () => {
    const bad = { ...sidecar, privateProof: 'PRIVATE_PROOF' }
    const html = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={{ objectiveTailorFinalOutcomes: bad, taskGraphSources: manifest }} lang="en" {...reviewProps} />)
    expect(html).toBe('')
    expect(html).not.toContain('PRIVATE_PROOF')
  })
})
