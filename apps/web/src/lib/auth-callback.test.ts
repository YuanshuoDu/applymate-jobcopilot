import { describe, expect, it } from 'vitest'
import { authLink, safeCallbackUrl } from './auth-callback'

describe('auth callback links', () => {
  it('keeps only same-origin relative callback paths', () => {
    expect(safeCallbackUrl('/?page=resume')).toBe('/?page=resume')
    expect(safeCallbackUrl('https://attacker.example/phish')).toBe('/')
    expect(safeCallbackUrl('//attacker.example/phish')).toBe('/')
  })

  it('adds a validated callback to auth links', () => {
    expect(authLink('/register', '/?page=agent')).toBe('/register?callbackUrl=%2F%3Fpage%3Dagent')
    expect(authLink('/login', '/')).toBe('/login')
  })
})
