import { describe, expect, it } from 'vitest'

import { TurnIntentSchema } from './turn-intent.js'
import { validate } from './validation.js'

describe('TurnIntent schema', () => {
  it('accepts the exact versioned server intent variants', () => {
    expect(validate(TurnIntentSchema, { kind: 'interactive_discovery_shortlist', version: 1 })).toBe(true)
    expect(validate(TurnIntentSchema, { kind: 'objective_task_graph_execution', version: 1 })).toBe(true)
  })

  it('rejects unknown kinds, versions, and extra fields', () => {
    for (const intent of [
      { kind: 'unknown', version: 1 },
      { kind: 'interactive_discovery_shortlist', version: 2 },
      { kind: 'objective_task_graph_execution', version: 2 },
      { kind: 'objective_task_graph_execution', version: 1, clientControlled: true },
    ]) {
      expect(validate(TurnIntentSchema, intent)).toBe(false)
    }
  })
})
