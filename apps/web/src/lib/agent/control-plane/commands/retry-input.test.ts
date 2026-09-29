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

    expect(result.selectedJobPreparation).toEqual({ jobId: 'job_1' })
  })

  it('rejects extra fields, empty text, and unsupported persisted content parts', () => {
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
})
