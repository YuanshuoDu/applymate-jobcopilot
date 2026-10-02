import { describe, expect, it } from 'vitest'

import { isRetryableTurnStatus, parsePersistedRetryContent } from './retry-input'

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

  it('rejects unknown fields and invalid values in persisted retry intent', () => {
    const base = { goal: 'Retry discovery', content: [{ type: 'text', text: 'Retry discovery' }] }
    for (const intent of [
      { kind: 'interactive_discovery_shortlist', version: 1, extra: true },
      { kind: 'other', version: 1 },
      { kind: 'interactive_discovery_shortlist', version: 2 },
    ]) {
      expect(() => parsePersistedRetryContent('turn-4', { ...base, intent })).toThrow()
    }
  })
})
