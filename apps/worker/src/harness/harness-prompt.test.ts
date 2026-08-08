import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, buildUserMessage, parseAction } from './harness-prompt.js'

describe('parseAction', () => {
  it('parses the final M3 JSON action after private reasoning', () => {
    const action = parseAction('<think>Choose the visible required field first.</think>\n```json\n{"type":"fill","selector":"#email","value":"ada@example.com","reasoning":"Use the candidate email."}\n```')

    expect(action).toMatchObject({
      type: 'fill', selector: '#email', value: 'ada@example.com', reasoning: 'Use the candidate email.',
    })
  })

  it('reserves the submit action for the final application control', () => {
    const systemPrompt = buildSystemPrompt({}, { title: 'Engineer', company: 'Acme' })
    const userMessage = buildUserMessage([], 'https://jobs.example.com/apply')

    expect(systemPrompt).toContain('Use type: \'submit\' only for the final application control')
    expect(userMessage).toContain('return type: \'submit\' with that control\'s selector')
  })
})
