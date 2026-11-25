import { afterEach, describe, expect, it, vi } from 'vitest'
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, REVIEWED_APPLICATION_REVIEW_INTENT } from '@jobcopilot/agent-protocol'

import { isRetryableTurnStatus, parsePersistedRetryContent } from './retry-input'
import { RETRY_LINEAGE_SCHEMA_VERSION } from './retry-lineage'
import { OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION } from './types'

afterEach(() => vi.unstubAllEnvs())

describe('persisted retry input', () => {
  it('preserves bounded text and attachment parts from retryable turns', () => {
    const result = parsePersistedRetryContent('turn-1', {
      goal: 'Retry the application', clientMessageId: 'message-1',
      content: [
        { type: 'text', text: 'Please retry' },
        { type: 'attachment_ref', attachmentId: 'attachment-1', mediaType: 'application/pdf' },
      ],
    })

    expect(result).toEqual({
      goal: 'Retry the application',
      content: [
        { type: 'text', text: 'Please retry' },
        { type: 'attachment_ref', attachmentId: 'attachment-1', mediaType: 'application/pdf' },
      ],
    })
    expect(isRetryableTurnStatus('failed')).toBe(true)
    expect(isRetryableTurnStatus('completed')).toBe(false)
  })

  it('preserves the typed selected-job context when retrying a failed preparation Turn', () => {
    const result = parsePersistedRetryContent('turn-2', {
      goal: 'Prepare a cover letter draft for the selected job',
      clientMessageId: 'message-2',
      content: [{ type: 'text', text: 'Prepare a cover letter draft for the selected job.' }],
      selectedJobPreparation: { jobId: 'job_1' },
    })

    expect(result).toEqual({
      goal: 'Prepare a cover letter draft for the selected job',
      content: [{ type: 'text', text: 'Prepare a cover letter draft for the selected job.' }],
      selectedJobPreparation: { jobId: 'job_1' },
    })
  })

  it('preserves the exact versioned interactive-discovery intent on retry', () => {
    const result = parsePersistedRetryContent('turn-3', {
      goal: 'Discover and shortlist relevant jobs using my saved job-search preferences.',
      clientMessageId: 'message-3',
      content: [{ type: 'text', text: 'Discover and shortlist relevant jobs using my saved job-search preferences.' }],
      intent: { kind: 'interactive_discovery_shortlist', version: 1 },
    })

    expect(result).toEqual({
      goal: 'Discover and shortlist relevant jobs using my saved job-search preferences.',
      content: [{ type: 'text', text: 'Discover and shortlist relevant jobs using my saved job-search preferences.' }],
      intent: { kind: 'interactive_discovery_shortlist', version: 1 },
    })
  })

  it('preserves the objective intent and valid verification requirements on retry', () => {
    const verificationRequirements = {
      schemaVersion: 'agent-harness.v2.objective-requirements.v1',
      requirements: [{ id: 'candidate-count', check: { kind: 'candidate_count_gte', minimum: 3 } }],
    } as const
    const result = parsePersistedRetryContent('turn-objective', {
      goal: 'Plan and execute the objective',
      content: [{ type: 'text', text: 'Plan and execute the objective' }],
      intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
      verificationRequirements,
    })

    expect(result).toEqual({
      goal: 'Plan and execute the objective',
      content: [{ type: 'text', text: 'Plan and execute the objective' }],
      intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
      verificationRequirements,
    })
  })

  it('preserves an explicit Objective report floor, including zero, through retry parsing', () => {
    const base = {
      goal: 'Retry the objective',
      content: [{ type: 'text', text: 'Retry the objective' }],
      intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
    }
    expect(parsePersistedRetryContent('turn-report-floor', { ...base, reportScoreFloor: 0 }))
      .toEqual({ ...base, reportScoreFloor: 0 })
    expect(parsePersistedRetryContent('turn-report-floor', { ...base, reportScoreFloor: 8 }))
      .toEqual({ ...base, reportScoreFloor: 8 })
    for (const reportScoreFloor of [null, -1, 10.1, '8']) {
      expect(() => parsePersistedRetryContent('turn-report-floor', { ...base, reportScoreFloor })).toThrow()
    }
    expect(() => parsePersistedRetryContent('turn-selected-floor', {
      goal: base.goal, content: base.content, selectedJobPreparation: { jobId: 'job_1' }, reportScoreFloor: 4,
    })).toThrow()
  })

  it('does not replay an approval-producing reviewed application intent through generic Retry', () => {
    expect(() => parsePersistedRetryContent('turn-review', {
      goal: 'Review selected materials for application fill',
      clientMessageId: 'review-message-1',
      content: [{ type: 'text', text: 'Review the selected materials.' }],
      selectedJobPreparation: { jobId: 'job_1' },
      intent: { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: 'source-turn-1' },
    })).toThrow()
  })

  it('rejects location verification requirements when the capability gate is off', () => {
    vi.stubEnv('AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED', '0')
    const verificationRequirements = {
      schemaVersion: OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
      requirements: [{ id: 'candidate-location', check: { kind: 'candidate_location_in', locations: ['dublin'] } }],
    } as const

    expect(() => parsePersistedRetryContent('turn-location-disabled', {
      goal: 'Retry the location-aware objective',
      content: [{ type: 'text', text: 'Retry the location-aware objective' }],
      verificationRequirements,
    })).toThrow()
  })

  it('preserves valid location verification requirements when the capability gate is on', () => {
    vi.stubEnv('AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED', '1')
    const verificationRequirements = {
      schemaVersion: OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
      requirements: [{ id: 'candidate-location', check: { kind: 'candidate_location_in', locations: ['dublin'] } }],
    } as const

    expect(parsePersistedRetryContent('turn-location-enabled', {
      goal: 'Retry the location-aware objective',
      content: [{ type: 'text', text: 'Retry the location-aware objective' }],
      verificationRequirements,
    })).toMatchObject({ verificationRequirements })
  })

  it('preserves count-only v1 requirements when the location capability gate is off', () => {
    vi.stubEnv('AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED', '0')
    const verificationRequirements = {
      schemaVersion: 'agent-harness.v2.objective-requirements.v1',
      requirements: [{ id: 'candidate-count', check: { kind: 'candidate_count_gte', minimum: 3 } }],
    } as const

    expect(parsePersistedRetryContent('turn-count-only-disabled', {
      goal: 'Retry the count-only objective',
      content: [{ type: 'text', text: 'Retry the count-only objective' }],
      verificationRequirements,
    })).toMatchObject({ verificationRequirements })
  })

  it('preserves the null verification-requirements sentinel and rejects malformed persisted requirements', () => {
    const base = { goal: 'Retry objective', content: [{ type: 'text', text: 'Retry objective' }] }
    expect(parsePersistedRetryContent('turn-null', { ...base, verificationRequirements: null }))
      .toMatchObject({ verificationRequirements: null })
    expect(() => parsePersistedRetryContent('turn-invalid', {
      ...base, verificationRequirements: { schemaVersion: 'unsupported', requirements: [] },
    })).toThrow()
  })

  it('rejects unknown persisted keys, empty text, and unsupported content parts', () => {
    expect(() => parsePersistedRetryContent('turn-1', {
      goal: 'Retry', content: [{ type: 'text', text: 'Retry' }], unexpected: true,
    })).toThrow()
    expect(() => parsePersistedRetryContent('turn-1', {
      goal: 'Retry', content: [{ type: 'text', text: 'Retry', secret: 'unexpected' }],
    })).toThrow()
    expect(() => parsePersistedRetryContent('turn-1', {
      goal: 'Retry', content: [{ type: 'text', text: '' }],
    })).toThrow()
    expect(() => parsePersistedRetryContent('turn-1', {
      goal: 'Retry', content: [{ type: 'image', url: 'https://example.test/image' }],
    })).toThrow()
  })

  it('validates but does not copy a prior private retry receipt into the next retry', () => {
    const base = { goal: 'Retry the same objective', content: [{ type: 'text', text: 'Retry the same objective' }] }
    const receipt = { schemaVersion: RETRY_LINEAGE_SCHEMA_VERSION, predecessorTurnId: 'turn-before', acceptedInputId: 'input-before', acceptedSequence: '18' }
    expect(parsePersistedRetryContent('turn-retry', { ...base, retryLineage: receipt })).toEqual(base)
    for (const retryLineage of [
      { ...receipt, acceptedSequence: '0' }, { ...receipt, extra: true }, { ...receipt, acceptedInputId: '' },
    ]) expect(() => parsePersistedRetryContent('turn-retry', { ...base, retryLineage })).toThrow()
  })

  it('rejects unknown fields and invalid values in persisted retry intent', () => {
    const base = { goal: 'Retry discovery', content: [{ type: 'text', text: 'Retry discovery' }] }
    expect(() => parsePersistedRetryContent('turn-recovery', {
      ...base,
      materialDriftRecovery: { schemaVersion: 'agent-harness.v2.material-drift-recovery.v1' },
    })).toThrow()
    for (const intent of [
      { kind: 'interactive_discovery_shortlist', version: 1, extra: true },
      { kind: 'other', version: 1 },
      { kind: 'interactive_discovery_shortlist', version: 2 },
      { kind: 'objective_task_graph_execution', version: 1, extra: true },
      { kind: 'objective_task_graph_execution', version: 2 },
      { kind: 'objective_task_graph_execution', version: 1, materialDriftRecovery: { schemaVersion: 'agent-harness.v2.material-drift-recovery.v1' } },
    ]) {
      expect(() => parsePersistedRetryContent('turn-4', { ...base, intent })).toThrow()
    }
  })
})
