import { describe, expect, it } from 'vitest'
import { mapPipelineEventToTranscript } from './pipeline-event-transcript'

describe('pipeline event transcript projection', () => {
  it('maps application review requests to the existing approval event shape', () => {
    expect(mapPipelineEventToTranscript('application_review_ready', {
      approval: { title: 'Review application', body: 'Check the final package.' },
    })).toEqual({
      type: 'approval_request',
      speaker: 'Reviewer',
      title: 'Review application',
      body: 'Check the final package.',
    })
  })

  it('maps artifact evidence without exposing an unbounded hash', () => {
    expect(mapPipelineEventToTranscript('artifact_created', {
      role: 'writer',
      artifact: { artifactId: 'resume-1', artifactType: 'resume', version: 2, hash: 'sha256:1234567890123456' },
    })).toMatchObject({
      type: 'quality_gate',
      speaker: 'Writer',
      title: 'Artifact draft',
      body: 'resume resume-1 v2 (sha256:123456789012…)',
    })
  })

  it('returns null for events with no legacy transcript projection', () => {
    expect(mapPipelineEventToTranscript('unknown_event', { message: 'ignore me' })).toBeNull()
  })
})
