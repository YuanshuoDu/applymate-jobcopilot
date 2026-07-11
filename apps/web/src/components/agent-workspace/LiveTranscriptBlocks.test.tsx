import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LiveTranscriptBlock, shouldRevealThinkingBlock } from './LiveTranscriptBlocks'

describe('thinking summary reveal', () => {
  it('reveals only thinking summary events after the chip increments', () => {
    expect(shouldRevealThinkingBlock('thinking_summary', 1)).toBe(true)
    expect(shouldRevealThinkingBlock('thinking_summary', 0)).toBe(false)
    expect(shouldRevealThinkingBlock('approval_request', 1)).toBe(false)
  })

  it('marks live transcript blocks with their event type for targeted scrolling', () => {
    const html = renderToString(
      <LiveTranscriptBlock
        event={{
          id: 'event_1',
          taskId: null,
          type: 'thinking_summary',
          speaker: 'Analyst',
          title: 'Thinking',
          body: 'Evidence summary',
          data: null,
          durationMs: null,
          createdAt: '2026-06-18T09:42:00.000Z',
        }}
        onAction={() => undefined}
      />,
    )

    expect(html).toContain('data-agent-event-type="thinking_summary"')
  })
})
