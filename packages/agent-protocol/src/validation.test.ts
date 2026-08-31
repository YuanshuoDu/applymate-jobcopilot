import { describe, expect, it } from 'vitest'
import { Type } from '@sinclair/typebox'
import { assertValid, ProtocolValidationError, validate, validatorCacheSize } from './validation.js'

const UserSchema = Type.Object({ id: Type.String({ minLength: 1 }) }, { $id: 'test.user' })

describe('Ajv validator cache', () => {
  it('caches validators and validates TypeBox output', () => {
    const before = validatorCacheSize()
    expect(validate(UserSchema, { id: 'user-1' })).toBe(true)
    expect(validate(UserSchema, { id: '' })).toBe(false)
    expect(validatorCacheSize()).toBe(before + 1)
    expect(validate(UserSchema, { id: 'user-2' })).toBe(true)
    expect(validatorCacheSize()).toBe(before + 1)
  })

  it('raises structured validation errors', () => {
    expect(() => assertValid(UserSchema, { id: '' }, 'user')).toThrow(ProtocolValidationError)
    try {
      assertValid(UserSchema, { id: '' }, 'user')
    } catch (error) {
      expect(error).toMatchObject({ name: 'ProtocolValidationError', issues: [{ keyword: 'minLength' }] })
    }
  })
})
