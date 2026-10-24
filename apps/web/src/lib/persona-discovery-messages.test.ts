import { describe, expect, it } from 'vitest'
import { isDiscoveryPersonaFactEnabled, personaDiscoveryMessage } from './persona-discovery-messages'
import type { Lang } from './i18n'

const languages: Lang[] = ['en', 'de', 'fr', 'es', 'nl', 'zh']

describe('persona discovery consent copy', () => {
  it('provides localized disclosure and controls for all supported languages', () => {
    for (const language of languages) {
      expect(personaDiscoveryMessage(language, 'title').length).toBeGreaterThan(3)
      expect(personaDiscoveryMessage(language, 'disclosure').length).toBeGreaterThan(100)
      expect(personaDiscoveryMessage(language, 'useFact').length).toBeGreaterThan(5)
      expect(personaDiscoveryMessage(language, 'stale').length).toBeGreaterThan(20)
    }
  })

  it('keeps consent off unless the exact discovery purpose is present', () => {
    expect(isDiscoveryPersonaFactEnabled([])).toBe(false)
    expect(isDiscoveryPersonaFactEnabled(['form_fill', 'tailor'])).toBe(false)
    expect(isDiscoveryPersonaFactEnabled(['discovery'])).toBe(true)
  })
})
