import { describe, expect, it } from 'vitest'
import { shouldStickToBottom } from './AgentUnifiedStream.helpers'

describe('shouldStickToBottom', () => {
  it('keeps following new messages when the user is already near the bottom', () => {
    expect(shouldStickToBottom({ scrollHeight: 1000, scrollTop: 710, clientHeight: 220 })).toBe(true)
  })

  it('does not pull a user reading older messages back to the bottom', () => {
    expect(shouldStickToBottom({ scrollHeight: 2000, scrollTop: 0, clientHeight: 500 })).toBe(false)
  })
})
