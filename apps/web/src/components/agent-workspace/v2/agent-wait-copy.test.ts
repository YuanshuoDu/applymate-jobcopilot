import { describe, expect, it } from 'vitest'

import { LANGUAGES } from '@/lib/i18n'
import { agentWaitCopy } from './agent-wait-copy'

describe('agent wait copy', () => {
  it('provides the wait states and match wording in all six Workbench languages', () => {
    for (const language of LANGUAGES) {
      const copy = agentWaitCopy(language.value)
      expect(copy.heading).toBeTruthy()
      expect(copy.anyMode).toBeTruthy()
      expect(copy.allMode).toBeTruthy()
      expect(copy.deadline).toBeTruthy()
      expect(copy.taskDeadline).toBeTruthy()
      expect(copy.taskDeadlineUnrecorded).toBeTruthy()
      expect(copy.waitDue).toBeTruthy()
      expect(copy.taskDue).toBeTruthy()
      expect(copy.empty).toBeTruthy()
      expect(copy.unavailable).toBeTruthy()
      expect(copy.error).toBeTruthy()
      expect(copy.matched).not.toBe(copy.notMatched)
      expect(copy.statuses.completed).toBeTruthy()
      expect(copy.selectTarget('Scout')).toBeTruthy()
    }
  })

  it('uses English for unknown language values', () => {
    expect(agentWaitCopy('unknown')).toEqual(agentWaitCopy('en'))
  })
})
