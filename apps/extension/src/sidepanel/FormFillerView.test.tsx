import { describe, expect, it } from 'vitest'
import { FormFillerView } from './FormFillerView'
import type { ExtensionSettings } from '@/lib/types'

const settings: ExtensionSettings = { apiBaseUrl: 'https://applymate.site', apiToken: 'first-token', userEmail: 'a@example.test', userName: 'Candidate', autoSave: false }

describe('form review account isolation', () => {
  it('mounts a fresh form session when the signed-in account changes', () => {
    const first = FormFillerView({ settings, scanTrigger: 0 })
    const second = FormFillerView({ settings: { ...settings, userEmail: 'b@example.test' }, scanTrigger: 0 })
    expect(first.key).not.toBe(second.key)
  })

  it('keeps same-account token refreshes in the same form session', () => {
    const first = FormFillerView({ settings, scanTrigger: 0 })
    const refreshed = FormFillerView({ settings: { ...settings, apiToken: 'refreshed-token', userEmail: ' A@example.test ', apiBaseUrl: 'https://applymate.site/' }, scanTrigger: 0 })
    expect(first.key).toBe(refreshed.key)
  })

  it('does not share reviewed answers between production and development accounts', () => {
    const first = FormFillerView({ settings, scanTrigger: 0 })
    const development = FormFillerView({ settings: { ...settings, apiBaseUrl: 'http://localhost:3000' }, scanTrigger: 0 })
    expect(first.key).not.toBe(development.key)
  })
})
