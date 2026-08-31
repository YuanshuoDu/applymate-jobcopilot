import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import { ActorSchema, TimestampSchema } from './common.js'

describe('common protocol schemas', () => {
  it('accepts canonical UTC timestamps and known actors', () => {
    expect(validate(TimestampSchema, '2026-08-31T00:00:00.000Z')).toBe(true)
    expect(validate(ActorSchema, 'orchestrator')).toBe(true)
  })

  it('rejects malformed timestamps and unknown actors', () => {
    expect(validate(TimestampSchema, '2026-08-31')).toBe(false)
    expect(validate(ActorSchema, 'operator')).toBe(false)
  })
})
