import { describe, expect, it } from 'vitest'
import { parseSupportCaseUpdate } from './support-case'

describe('support case update validation', () => {
  it('requires an optimistic version and only allows known state values', () => {
    expect(parseSupportCaseUpdate({ status: 'resolved', version: 2 })).toEqual({ status: 'resolved', priority: undefined, assignedAdminId: undefined, version: 2 })
    expect(parseSupportCaseUpdate({ status: 'deleted', version: 2 })).toBeNull()
    expect(parseSupportCaseUpdate({ priority: 'high' })).toBeNull()
  })
})
