import { describe, expect, it } from 'vitest'
import { EXTENSION_TRANSLATION_KEYS, translateExtension } from './i18n'

describe('extension language switching', () => {
  it('uses English by default and Chinese when selected', () => {
    expect(translateExtension('en', 'Loading resumes')).toBe('Loading resumes')
    expect(translateExtension('zh', 'Loading resumes')).toBe('正在加载简历')
  })

  it('keeps brand names but does not leak unknown UI copy in Chinese mode', () => {
    expect(translateExtension('zh', 'ApplyMate')).toBe('ApplyMate')
    expect(translateExtension('zh', 'Unexpected English UI copy')).toBe('出了点问题，请重试')
  })

  it('has a Chinese value for every registered extension string', () => {
    for (const key of EXTENSION_TRANSLATION_KEYS) {
      expect(translateExtension('zh', key), key).not.toBe(key)
    }
  })

  it('keeps registered English strings free of Chinese characters', () => {
    for (const key of EXTENSION_TRANSLATION_KEYS) {
      expect(translateExtension('en', key), key).not.toMatch(/[\u3400-\u9fff]/)
    }
  })
})
