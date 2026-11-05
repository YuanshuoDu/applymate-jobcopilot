import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const locale = vi.hoisted(() => ({ lang: 'en' }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => locale }))
import PrivacyPage from './page'
import { MODEL_CATALOGUE } from '@/lib/model-router-client'

describe('public privacy disclosure', () => {
  it('identifies all selectable AI provider families and distinguishes custom recipients', () => {
    locale.lang = 'en'
    const html = renderToStaticMarkup(<PrivacyPage />)
    const names: Record<string, string> = {
      minimax: 'MiniMax', openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek',
      qwen: 'Alibaba Cloud / Qwen', zhipu: 'Z.ai / Zhipu', kimi: 'Moonshot / Kimi', custom: 'custom OpenAI-compatible endpoint',
    }
    for (const provider of new Set(MODEL_CATALOGUE.map(model => model.provider))) {
      expect(names[provider]).toBeDefined()
      expect(html).toContain(names[provider])
    }
    expect(html).toContain('not a claim that every provider receives your data')
    expect(html).toContain('Chrome Web Store User Data Policy')
    expect(html).toContain('Google API Services User Data Policy')
  })

  it.each(['en', 'zh'])('keeps deletion and retention limits visible in %s', lang => {
    locale.lang = lang
    const html = renderToStaticMarkup(<PrivacyPage />)
    expect(html).toContain(lang === 'en' ? 'does not immediately erase the account' : '不会立即删除账户')
    expect(html).toContain(lang === 'en' ? 'not a 90-day expiry for all user data' : '不代表所有用户数据都在 90 天后删除')
    expect(html).toContain('24')
    expect(html).toContain('legal@applymate.ai')
  })

  it.each(['en', 'zh'])('offers the public support form before the additional email contact in %s', lang => {
    locale.lang = lang
    const html = renderToStaticMarkup(<PrivacyPage />)
    const formLink = html.indexOf('href="/landing#contact"')
    expect(formLink).toBeGreaterThan(-1)
    expect(formLink).toBeLessThan(html.indexOf('href="mailto:legal@applymate.ai"'))
    expect(html).toContain(lang === 'en' ? 'Sign-in is not required' : '无需登录')
    expect(html).toContain(lang === 'en' ? 'Privacy / data request' : '隐私 / 数据请求')
  })
})
