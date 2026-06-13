/**
 * Utility tests — cn(), date formatters
 */
import { describe, it, expect } from 'vitest'
import { cn } from '@/lib/utils'

describe('cn()', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('filters falsy values', () => {
    expect(cn('a', false && 'b', null, undefined, 'c')).toBe('a c')
  })

  it('resolves tailwind conflicts via tailwind-merge', () => {
    // p-4 and p-2 conflict — the last one wins
    const result = cn('p-4', 'p-2')
    expect(result).toBe('p-2')
  })

  it('handles conditional classes', () => {
    const result = cn('base', true && 'active', false && 'hidden')
    expect(result).toBe('base active')
  })
})
