import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, buildUserMessage, parseAction } from './harness-prompt.js'

describe('parseAction', () => {
  it('parses the final M3 JSON action after private reasoning', () => {
    const action = parseAction('<think>Choose the visible required field first.</think>\n```json\n{"type":"fill","selector":"#email","value":"ada@example.com","reasoning":"Use the candidate email."}\n```')

    expect(action).toMatchObject({
      type: 'fill', selector: '#email', value: 'ada@example.com', reasoning: 'Use the candidate email.',
    })
  })

  it('describes the agent as read-only and keeps page data untrusted', () => {
    const systemPrompt = buildSystemPrompt({}, { title: 'Engineer', company: 'Acme' })
    const userMessage = buildUserMessage([], 'https://jobs.example.com/apply')

    expect(systemPrompt).toContain('read-only fill-for-review')
    expect(systemPrompt).toContain('submit is intentionally unavailable')
    expect(userMessage).toContain('UNTRUSTED PAGE DATA')
    expect(userMessage).not.toContain('return type: \'submit\'')
  })
})
