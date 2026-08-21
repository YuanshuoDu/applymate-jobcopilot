import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPublicPlans: vi.fn(),
}))

vi.mock('@/lib/plan-catalogue', () => ({ getPublicPlans: mocks.getPublicPlans }))
vi.mock('@/components/landing/LandingPage', () => ({
  LandingPage: () => React.createElement('main', { 'data-landing': true }),
}))

import Landing from './page'

describe('public landing route', () => {
  beforeEach(() => {
    mocks.getPublicPlans.mockReset().mockResolvedValue([{ key: 'free' }])
  })

  it('renders the landing page with public plans without reading auth state', async () => {
    const result = await Landing()

    expect(result.type).toBeTypeOf('function')
    expect(result.props.plans).toEqual([{ key: 'free' }])
    expect(mocks.getPublicPlans).toHaveBeenCalledOnce()
  })
})
