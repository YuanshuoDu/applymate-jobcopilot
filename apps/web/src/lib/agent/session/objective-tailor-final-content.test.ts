import { describe, expect, it } from 'vitest'

import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA as schema } from '@jobcopilot/agent-protocol'
import {
  contentWithoutObjectiveTailorFinalOutcomes,
  parseObjectiveTailorFinalOutcomesFromContent,
  stripObjectiveTailorFinalOutcomes,
} from './objective-tailor-final-content'

const sidecar = { schemaVersion: schema, slots: [{ ordinal: 1, status: 'ready' }] }

describe('Objective Tailor final content projection', () => {
  it('reads and returns only the closed protocol sidecar', () => {
    expect(parseObjectiveTailorFinalOutcomesFromContent({ objectiveTailorFinalOutcomes: sidecar, taskId: 'private' }))
      .toEqual(sidecar)
    expect(contentWithoutObjectiveTailorFinalOutcomes({ text: 'Answer', objectiveTailorFinalOutcomes: sidecar }))
      .toEqual({ text: 'Answer' })
  })

  it('rejects malformed, accessor-backed, and inherited sidecars', () => {
    const accessor = Object.defineProperty({}, 'objectiveTailorFinalOutcomes', { enumerable: true, get: () => sidecar })
    expect(parseObjectiveTailorFinalOutcomesFromContent({ objectiveTailorFinalOutcomes: { ...sidecar, privateId: 'x' } })).toBeUndefined()
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
