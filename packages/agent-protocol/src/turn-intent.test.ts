import { describe, expect, it } from 'vitest'

import { REVIEWED_APPLICATION_REVIEW_INTENT, TurnIntentSchema } from './turn-intent.js'
import { validate } from './validation.js'

describe('TurnIntent schema', () => {
  it('accepts the exact versioned server intent variants', () => {
    expect(validate(TurnIntentSchema, { kind: 'interactive_discovery_shortlist', version: 1 })).toBe(true)
    expect(validate(TurnIntentSchema, { kind: 'objective_task_graph_execution', version: 1 })).toBe(true)
    expect(validate(TurnIntentSchema, { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1', jobId: 'job-1' })).toBe(true)
  })

  it('rejects unknown kinds, versions, and extra fields', () => {
    for (const intent of [
      { kind: 'unknown', version: 1 },
      { kind: 'interactive_discovery_shortlist', version: 2 },
      { kind: 'objective_task_graph_execution', version: 2 },
      { kind: 'objective_task_graph_execution', version: 1, clientControlled: true },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, jobId: 'job-1' },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1' },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: '', jobId: 'job-1' },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'x'.repeat(257), jobId: 'job-1' },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1', jobId: '' },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1', jobId: 'x'.repeat(257) },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1', jobId: 'job-1', clientControlled: true },
      { kind: 'reviewed_application_review', version: 2, sourceTurnId: 'source-turn-1' },
    ]) {
      expect(validate(TurnIntentSchema, intent)).toBe(false)
    }
  })
})
