import { describe, expect, it } from 'vitest'
import { isDiscoveryPersonaFactEnabled, personaDiscoveryMessage } from './persona-discovery-messages'
import type { Lang } from './i18n'

const languages: Lang[] = ['en', 'de', 'fr', 'es', 'nl', 'zh']

describe('persona discovery consent copy', () => {
  it('provides localized disclosure and controls for all supported languages', () => {
    for (const language of languages) {
      expect(personaDiscoveryMessage(language, 'title').length).toBeGreaterThan(3)
      expect(personaDiscoveryMessage(language, 'disclosure').length).toBeGreaterThan(100)
      expect(personaDiscoveryMessage(language, 'capacityNote').length).toBeGreaterThan(40)
      expect(personaDiscoveryMessage(language, 'capacityUnknown').length).toBeGreaterThan(5)
      expect(personaDiscoveryMessage(language, 'useFact').length).toBeGreaterThan(5)
      expect(personaDiscoveryMessage(language, 'stale').length).toBeGreaterThan(20)
    }
  })

  it('substitutes bounded numeric capacity values without leaking placeholders', () => {
    const message = personaDiscoveryMessage('en', 'capacityByteOverflow', {
      factCount: 3, factLimit: 32, bytes: 9000, byteLimit: 8192,
    })
    expect(message).toContain('3/32 selected facts')
    expect(message).toContain('9000/8192 UTF-8 bytes')
    expect(message).not.toContain('{')
  })

  it('keeps consent off unless the exact discovery purpose is present', () => {
    expect(isDiscoveryPersonaFactEnabled([])).toBe(false)
    expect(isDiscoveryPersonaFactEnabled(['form_fill', 'tailor'])).toBe(false)
    expect(isDiscoveryPersonaFactEnabled(['discovery'])).toBe(true)
  })
})
