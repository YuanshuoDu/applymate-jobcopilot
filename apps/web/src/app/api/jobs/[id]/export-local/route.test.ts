import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/api-helpers', () => ({ requireAuth: vi.fn(), isErrorResponse: vi.fn(), err: vi.fn() }))
import { POST as legacyPost } from './route'
import { POST as downloadPost } from '../application-pack/route'

describe('legacy export URL', () => {
  it('uses the same authenticated, revision-checked ZIP handler', () => {
    expect(legacyPost).toBe(downloadPost)
  })
})
