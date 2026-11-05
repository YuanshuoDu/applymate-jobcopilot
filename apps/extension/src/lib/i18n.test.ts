import { act, createElement, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { EXTENSION_TRANSLATION_KEYS, translateExtension, useExtensionI18n } from './i18n'
import { LABELS } from '../popup/popup-constants'

describe('extension language switching', () => {
  it('uses English by default and Chinese when selected', () => {
    expect(translateExtension('en', 'Loading resumes')).toBe('Loading resumes')
    expect(translateExtension('zh', 'Loading resumes')).toBe('正在加载简历')
  })

  it('translates dynamic progress copy in Chinese mode', () => {
    expect(translateExtension('zh', 'Filled 2 of 3 fields')).toBe('已填写 2 / 3 个字段')
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

  it('keeps English popup labels free of Chinese characters', () => {
    for (const [key, value] of Object.entries(LABELS.en)) {
      expect(value, key).not.toMatch(/[\u3400-\u9fff]/)
    }
  })
})

describe('translation callback used by loading effects', () => {
  it('stays stable after data and parent rerenders, and updates when the language changes', async () => {
    vi.useFakeTimers()
    let language = 'en'
    vi.stubGlobal('localStorage', { getItem: () => language })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    // This real React root renders a null probe, so it needs only event targets,
    // not a DOM emulator. React itself owns all hook state and effect scheduling.
    const ownerDocument = { nodeType: 9, addEventListener() {}, removeEventListener() {}, body: { nodeName: 'BODY' } }
    const container = { nodeType: 1, tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument, addEventListener() {}, removeEventListener() {}, textContent: '' }
    vi.stubGlobal('window', { document: ownerDocument, HTMLIFrameElement: class {}, setInterval, clearInterval })
    const root = createRoot(container as unknown as HTMLElement)
    const observed: Array<ReturnType<typeof useExtensionI18n>> = []
    const load = vi.fn().mockImplementation(() => {
      // Bound a regression so an unstable callback fails without hanging tests.
      return load.mock.calls.length <= 5 ? Promise.resolve({ profile: 'sample' }) : new Promise(() => {})
    })
    function Probe() {
      const value = useExtensionI18n()
      const [, setData] = useState<unknown>(null)
      observed.push(value)
      useEffect(() => { void load().then(setData) }, [value.t])
      return null
    }
    try {
      await act(async () => { root.render(createElement(Probe)) })
      const english = observed.at(-1)!.t
      expect(load).toHaveBeenCalledTimes(1)
      expect(english('Loading profile')).toBe('Loading profile')
      await act(async () => { root.render(createElement(Probe)) })
      expect(observed.at(-1)!.t).toBe(english)
      expect(load).toHaveBeenCalledTimes(1)
      await act(async () => { vi.advanceTimersByTime(500) })
      expect(load).toHaveBeenCalledTimes(1)

      language = 'zh'
      await act(async () => { vi.advanceTimersByTime(500) })
      const chinese = observed.at(-1)!.t
      expect(chinese).not.toBe(english)
      expect(chinese('Loading profile')).toBe('正在加载画像')
      expect(load).toHaveBeenCalledTimes(2)
      await act(async () => { root.render(createElement(Probe)); vi.advanceTimersByTime(500) })
      expect(observed.at(-1)!.t).toBe(chinese)
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      await act(async () => { root.unmount() })
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
