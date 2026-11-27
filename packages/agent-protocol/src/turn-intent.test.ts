import { describe, expect, it } from 'vitest'

import { validate } from './validation.js'
import {
  OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
  SELECTED_JOB_BATCH_PREPARATION_INTENT,
  TurnIntentSchema,
} from './turn-intent.js'

describe('closed Turn intents', () => {
  it('adds the server-owned batch marker without changing existing intents', () => {
    expect(validate(TurnIntentSchema, SELECTED_JOB_BATCH_PREPARATION_INTENT)).toBe(true)
    expect(validate(TurnIntentSchema, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT)).toBe(true)
    expect(validate(TurnIntentSchema, { kind: 'interactive_discovery_shortlist', version: 1 })).toBe(true)
    for (const intent of [
      { kind: 'unknown', version: 1 },
      { kind: 'interactive_discovery_shortlist', version: 2 },
      { kind: 'objective_task_graph_execution', version: 2 },
      { ...OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, clientControlled: true },
      { ...SELECTED_JOB_BATCH_PREPARATION_INTENT, sourceTurnId: 'turn-1' },
      { kind: 'selected_job_batch_preparation', version: 2 },
    ]) expect(validate(TurnIntentSchema, intent)).toBe(false)
  })
})
