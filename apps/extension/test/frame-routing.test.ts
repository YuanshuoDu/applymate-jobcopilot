import { describe, expect, it } from 'vitest'
import { groupFieldIdsByFrame, groupFilledFieldsByFrame } from '../src/lib/form-filler/frame-routing'

describe('form frame routing', () => {
  const schemas = [
    { id: 'frame|0|name', frameId: 0, type: 'text' as const, label: 'Name', required: true, surroundingText: '' },
    { id: 'frame|4|email', frameId: 4, type: 'email' as const, label: 'Email', required: true, surroundingText: '' },
  ]

  it('groups fill requests by owning iframe', () => {
    const groups = groupFilledFieldsByFrame([
      { fieldId: 'frame|4|email', value: 'a@example.com', confidence: 1, reasoning: '', skip: false },
      { fieldId: 'frame|0|name', value: 'A', confidence: 1, reasoning: '', skip: false },
    ], schemas)
    expect(groups.map(group => [group.frameId, group.fields.map(field => field.fieldId)])).toEqual([
      [0, ['frame|0|name']],
      [4, ['frame|4|email']],
    ])
  })

  it('routes reads for unknown legacy fields to the main frame', () => {
    const groups = groupFieldIdsByFrame(['frame|4|email', 'legacy'], schemas)
    expect(groups.get(4)).toEqual(['frame|4|email'])
    expect(groups.get(0)).toEqual(['legacy'])
  })
})
