import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./OnboardingFlow.css', import.meta.url), 'utf8')

describe('OnboardingFlow mobile layout', () => {
  it('keeps per-step skip controls visible on phone layouts', () => {
    expect(css).not.toMatch(/\.onboarding-skip\s*\{\s*display\s*:\s*none\s*\}/)
  })
})
