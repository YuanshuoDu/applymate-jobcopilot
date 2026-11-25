import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA as schema,
  OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA as schemaV2,
} from '@jobcopilot/agent-protocol'
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
    expect(en).not.toContain('Source counts')
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

  it('shows complete zero and partial lower bounds in both languages while preserving slots', () => {
    const v2 = { schemaVersion: schemaV2, graphRevision: 4, slots: sidecar.slots, sourceCounts: {
      discoveredJobs: { knownCount: 0, coverage: 'complete' },
      analyzedJobs: { knownCount: 3, coverage: 'partial' },
    } }
    const en = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={{ objectiveTailorFinalOutcomes: v2 }} lang="en" />)
    const zh = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={{ objectiveTailorFinalOutcomes: v2 }} lang="zh" />)
    expect(en).toContain('Found jobs')
    expect(en).toContain('0 (complete coverage)')
    expect(en).toContain('At least 3 (partial coverage)')
    expect(en).toContain('Job 2: Needs revision')
    expect(zh).toContain('已发现职位')
    expect(zh).toContain('0（完整覆盖）')
    expect(zh).toContain('至少 3（部分覆盖）')
    expect(zh).toContain('职位 2: 需要修改')
  })

  it('distinguishes unavailable from not requested in both languages', () => {
    const v2 = { schemaVersion: schemaV2, graphRevision: 5, slots: sidecar.slots, sourceCounts: {
      discoveredJobs: { knownCount: null, coverage: 'unavailable' },
      analyzedJobs: { knownCount: null, coverage: 'not_requested' },
    } }
    const en = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={{ objectiveTailorFinalOutcomes: v2 }} lang="en" />)
    const zh = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={{ objectiveTailorFinalOutcomes: v2 }} lang="zh" />)
    expect(en).toContain('Unavailable')
    expect(en).toContain('Not requested')
    expect(zh).toContain('不可用')
    expect(zh).toContain('未请求')
  })

  it('hides malformed sidecars and does not render private extra fields', () => {
    const bad = { ...sidecar, privateProof: 'PRIVATE_PROOF' }
    const html = renderToStaticMarkup(<ObjectiveTailorFinalOutcomes content={{ objectiveTailorFinalOutcomes: bad, taskGraphSources: manifest }} lang="en" {...reviewProps} />)
    expect(html).toBe('')
    expect(html).not.toContain('PRIVATE_PROOF')
  })
})
