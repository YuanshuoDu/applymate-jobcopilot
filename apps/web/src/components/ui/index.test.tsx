import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { translate } from '@/lib/i18n'
import { Btn, localizeToastText } from './index'

describe('Btn', () => {
  it('uses a native disabled button when disabled', () => {
    const markup = renderToStaticMarkup(<Btn disabled>Unavailable</Btn>)

    expect(markup).toContain('disabled=""')
  })
})

describe('toast localization', () => {
  it.each(['en', 'zh'] as const)('preserves trusted recovery and conflict messages in %s', lang => {
    for (const key of ['resume.restoreUnknownTitle', 'resume.restoreUnknownDetail', 'resume.correctionChangedTitle', 'resume.correctionChangedDetail', 'resume.cachedVersionDetail']) {
      const message = translate(lang, key)
      expect(localizeToastText(lang, message)).toBe(message)
    }
  })
  it('does not expose unrecognized server text in Chinese', () => {
    expect(localizeToastText('zh', 'Server failed for private@example.invalid: access token SECRET')).toBe(translate('zh', 'toast.genericDetail'))
  })
  it('preserves the existing English display behavior', () => {
    expect(localizeToastText('en', 'custom existing message')).toBe('custom existing message')
  })
  it('still translates known legacy labels and leaves absent descriptions absent', () => {
    expect(localizeToastText('zh', 'Save failed')).toBe(translate('zh', 'toast.saveFailed'))
    expect(localizeToastText('en', undefined)).toBeUndefined()
  })
})
