import { describe, expect, it } from 'vitest'
import { parseAction } from './harness-prompt.js'

describe('parseAction', () => {
  it('parses the final M3 JSON action after private reasoning', () => {
    const action = parseAction('<think>Choose the visible required field first.</think>\n```json\n{"type":"fill","selector":"#email","value":"ada@example.com","reasoning":"Use the candidate email."}\n```')

    expect(action).toMatchObject({
      type: 'fill', selector: '#email', value: 'ada@example.com', reasoning: 'Use the candidate email.',
    })
  })
})
