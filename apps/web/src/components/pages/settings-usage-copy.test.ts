import { describe, expect, it } from 'vitest'
import { hasTranslation, LANGUAGES, translate } from '@/lib/i18n'
import { SETTINGS_USAGE_COPY } from './settings-usage-copy'

describe('personal usage language resources', () => {
  it('covers every app language with a complete, nonempty set of labels', () => {
    const expectedKeys = Object.keys(SETTINGS_USAGE_COPY.en).sort()
    expect(Object.keys(SETTINGS_USAGE_COPY).sort()).toEqual(LANGUAGES.map(({ value }) => value).sort())
    for (const { value: lang } of LANGUAGES) {
      const copy = SETTINGS_USAGE_COPY[lang]
      expect(Object.keys(copy).sort(), `${lang} keys`).toEqual(expectedKeys)
      for (const [key, value] of Object.entries(copy)) expect(value.trim(), `${lang}.${key}`).not.toBe('')
      expect(hasTranslation(lang, 'settings.usage'), `${lang} menu label`).toBe(true)
      expect(translate(lang, 'settings.usage')).toBe(copy.title)
    }
  })

  it('provides localised headings and date-range controls for all four additional languages', () => {
    for (const lang of ['de', 'fr', 'es', 'nl'] as const) {
      const copy = SETTINGS_USAGE_COPY[lang]
      expect(copy.title).not.toBe(SETTINGS_USAGE_COPY.en.title)
      expect(copy.week).not.toBe(SETTINGS_USAGE_COPY.en.week)
      expect(copy.month).not.toBe(SETTINGS_USAGE_COPY.en.month)
      expect(copy.error).not.toBe(SETTINGS_USAGE_COPY.en.error)
      expect(copy.empty).not.toBe(SETTINGS_USAGE_COPY.en.empty)
    }
  })
})
