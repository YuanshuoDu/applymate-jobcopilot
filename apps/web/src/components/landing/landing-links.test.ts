import { describe, expect, it } from 'vitest'
import { landingFeatureHref, landingPlanAction } from './landing-links'

describe('landing action links', () => {
  it('takes unauthenticated feature visitors through registration to the product page', () => {
    expect(landingFeatureHref('resume')).toBe('/register?callbackUrl=%2F%3Fpage%3Dresume')
    expect(landingFeatureHref('gmail')).toBe('/register?callbackUrl=%2F%3Fpage%3Dgmail')
  })

  it('uses contact for paid plan actions instead of pretending checkout exists', () => {
    expect(landingPlanAction('free')).toEqual({ href: '/register' })
    expect(landingPlanAction('pro')).toEqual({
      href: '#contact',
      message: 'I would like to start the Pro free trial.',
    })
    expect(landingPlanAction('enterprise')).toEqual({
      href: '#contact',
      message: 'I would like to discuss a Team plan for my organisation.',
    })
  })
})
