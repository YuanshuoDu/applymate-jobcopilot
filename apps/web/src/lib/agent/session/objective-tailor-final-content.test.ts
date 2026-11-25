import { describe, expect, it } from 'vitest'

import {
  OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA as schema,
  OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA as schemaV2,
} from '@jobcopilot/agent-protocol'
import {
  contentWithoutObjectiveTailorFinalOutcomes,
  parseObjectiveTailorFinalOutcomesFromContent,
  stripObjectiveTailorFinalOutcomes,
} from './objective-tailor-final-content'

const sidecar = { schemaVersion: schema, slots: [{ ordinal: 1, status: 'ready' }] }
const sidecarV2 = {
  schemaVersion: schemaV2, graphRevision: 19,
  slots: [{ ordinal: 1, status: 'ready' }, { ordinal: 2, status: 'needs_revision' }],
  sourceCounts: {
    discoveredJobs: { knownCount: 0, coverage: 'complete' },
    analyzedJobs: { knownCount: 3, coverage: 'partial' },
  },
}

describe('Objective Tailor final content projection', () => {
  it('reads and returns only the closed protocol sidecar', () => {
    expect(parseObjectiveTailorFinalOutcomesFromContent({ objectiveTailorFinalOutcomes: sidecar, taskId: 'private' }))
      .toEqual(sidecar)
    expect(contentWithoutObjectiveTailorFinalOutcomes({ text: 'Answer', objectiveTailorFinalOutcomes: sidecar }))
      .toEqual({ text: 'Answer' })
  })

  it('preserves V2 source counts and coverage in the final content projection', () => {
    expect(parseObjectiveTailorFinalOutcomesFromContent({ objectiveTailorFinalOutcomes: sidecarV2, taskId: 'private' }))
      .toEqual(sidecarV2)
    expect(contentWithoutObjectiveTailorFinalOutcomes({ text: 'Answer', objectiveTailorFinalOutcomes: sidecarV2 }))
      .toEqual({ text: 'Answer' })
  })

  it('keeps complete zero, partial, unavailable, and not-requested counts distinct', () => {
    const count = (knownCount: number | null, coverage: string) => ({ knownCount, coverage })
    expect(parseObjectiveTailorFinalOutcomesFromContent({ objectiveTailorFinalOutcomes: {
      ...sidecarV2,
      sourceCounts: {
        discoveredJobs: count(0, 'complete'),
        analyzedJobs: count(null, 'unavailable'),
      },
    } })).toMatchObject({ sourceCounts: {
      discoveredJobs: { knownCount: 0, coverage: 'complete' },
      analyzedJobs: { knownCount: null, coverage: 'unavailable' },
    } })
    expect(parseObjectiveTailorFinalOutcomesFromContent({ objectiveTailorFinalOutcomes: {
      ...sidecarV2,
      sourceCounts: {
        discoveredJobs: count(null, 'not_requested'),
        analyzedJobs: count(2, 'partial'),
      },
    } })).toMatchObject({ sourceCounts: {
      discoveredJobs: { knownCount: null, coverage: 'not_requested' },
      analyzedJobs: { knownCount: 2, coverage: 'partial' },
    } })
  })

  it('rejects malformed, accessor-backed, and inherited sidecars', () => {
    const accessor = Object.defineProperty({}, 'objectiveTailorFinalOutcomes', { enumerable: true, get: () => sidecar })
    expect(parseObjectiveTailorFinalOutcomesFromContent({ objectiveTailorFinalOutcomes: { ...sidecar, privateId: 'x' } })).toBeUndefined()
    expect(parseObjectiveTailorFinalOutcomesFromContent({ objectiveTailorFinalOutcomes: { ...sidecarV2, privateProof: 'x' } })).toBeUndefined()
    expect(parseObjectiveTailorFinalOutcomesFromContent(accessor)).toBeUndefined()
    expect(parseObjectiveTailorFinalOutcomesFromContent(Object.create({ objectiveTailorFinalOutcomes: sidecar }))).toBeUndefined()
    expect(contentWithoutObjectiveTailorFinalOutcomes(accessor)).toBeNull()
  })

  it('removes sidecar keys from generic redacted payloads at any nesting level', () => {
    expect(stripObjectiveTailorFinalOutcomes({ content: { objectiveTailorFinalOutcomes: sidecar, text: 'Safe' } }))
      .toEqual({ content: { text: 'Safe' } })
  })

  it('preserves JSON __proto__ members as inert own properties while copying', () => {
    const content = JSON.parse('{"text":"Safe","__proto__":{"polluted":true},"objectiveTailorFinalOutcomes":{"bad":true}}') as unknown
    const copied = contentWithoutObjectiveTailorFinalOutcomes(content)
    expect(copied && Object.getPrototypeOf(copied)).toBe(Object.prototype)
    expect(copied && Object.hasOwn(copied, '__proto__')).toBe(true)
    const stripped = stripObjectiveTailorFinalOutcomes(content) as Record<string, unknown>
    expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype)
    expect(Object.hasOwn(stripped, '__proto__')).toBe(true)
  })
})
