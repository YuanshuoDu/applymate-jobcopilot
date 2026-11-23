import { describe, expect, it } from 'vitest'

import { validate } from './validation.js'
import {
  OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
  REVIEWED_APPLICATION_REVIEW_INTENT,
  SELECTED_JOB_BATCH_PREPARATION_INTENT,
  TurnIntentSchema,
} from './turn-intent.js'

describe('closed Turn intents', () => {
  it('accepts exact server-owned intents without changing existing variants', () => {
    expect(validate(TurnIntentSchema, SELECTED_JOB_BATCH_PREPARATION_INTENT)).toBe(true)
    expect(validate(TurnIntentSchema, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT)).toBe(true)
    expect(validate(TurnIntentSchema, { kind: 'interactive_discovery_shortlist', version: 1 })).toBe(true)
    expect(validate(TurnIntentSchema, { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1', jobId: 'job-1' })).toBe(true)
  })

  it('rejects unknown kinds, versions, and extra fields', () => {
    for (const intent of [
      { kind: 'unknown', version: 1 },
      { kind: 'interactive_discovery_shortlist', version: 2 },
      { kind: 'objective_task_graph_execution', version: 2 },
      { kind: 'objective_task_graph_execution', version: 1, clientControlled: true },
      { ...SELECTED_JOB_BATCH_PREPARATION_INTENT, sourceTurnId: 'turn-1' },
      { kind: 'selected_job_batch_preparation', version: 2 },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, jobId: 'job-1' },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1' },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: '', jobId: 'job-1' },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'x'.repeat(257), jobId: 'job-1' },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1', jobId: '' },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1', jobId: 'x'.repeat(257) },
      { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1', jobId: 'job-1', clientControlled: true },
      { kind: 'reviewed_application_review', version: 2, sourceTurnId: 'source-turn-1' },
    ]) expect(validate(TurnIntentSchema, intent)).toBe(false)
  })
})
