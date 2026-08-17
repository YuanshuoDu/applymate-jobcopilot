import { describe, expect, it } from 'vitest'
import { EXTENSION_TRANSLATION_KEYS, translateExtension } from './i18n'

describe('extension language switching', () => {
  it('uses English by default and Chinese when selected', () => {
    expect(translateExtension('en', 'Loading resumes')).toBe('Loading resumes')
    expect(translateExtension('zh', 'Loading resumes')).toBe('正在加载简历')
  })

  it('keeps unknown English copy unchanged until it is explicitly translated', () => {
    expect(translateExtension('zh', 'ApplyMate')).toBe('ApplyMate')
  })

  it('has a Chinese value for every registered extension string', () => {
    for (const key of EXTENSION_TRANSLATION_KEYS) {
      expect(translateExtension('zh', key), key).not.toBe(key)
    }
  })
})
