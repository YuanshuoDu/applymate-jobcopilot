import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider, translate, useI18n } from './i18n'

function TranslationProbe() {
  const { t } = useI18n()
  return <span>{t('settings.ai.saved')}</span>
}

describe('AI settings translations', () => {
  it('renders a user-facing saved-key placeholder instead of the translation key', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TranslationProbe />
      </I18nProvider>,
    )

    expect(html).toContain('Saved - paste a new value to replace it')
    expect(html).not.toContain('settings.ai.saved')
  })

  it('keeps English and Chinese UI translations separate', () => {
    expect(translate('en', 'nav.dashboard')).toBe('Dashboard')
    expect(translate('zh', 'nav.dashboard')).toBe('仪表板')
    expect(translate('en', 'nav.dashboard')).not.toBe(translate('zh', 'nav.dashboard'))
  })
})
