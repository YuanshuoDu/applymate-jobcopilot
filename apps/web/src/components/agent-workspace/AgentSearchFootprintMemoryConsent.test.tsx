import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hookState = vi.hoisted(() => ({
  overrides: null as unknown[] | null,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
}))
const localeState = vi.hoisted(() => ({ lang: 'en' as 'en' | 'zh' }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useCallback: (callback: unknown) => callback,
    useEffect: () => undefined,
    useState: (initial: unknown) => {
      const value = hookState.overrides?.shift()
      const setter = vi.fn()
      hookState.setters.push(setter)
      return [value === undefined ? initial : value, setter]
    },
  }
})
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: localeState.lang }) }))

import { AgentSearchFootprintMemoryConsent } from './AgentSearchFootprintMemoryConsent'

const MAX_CONSENT_VERSION = 2_147_483_647
type CheckboxProps = { checked: boolean; disabled: boolean; onChange: (event: { currentTarget: { checked: boolean } }) => void }

function findCheckbox(value: React.ReactNode): React.ReactElement<CheckboxProps> | undefined {
  for (const child of React.Children.toArray(value)) {
    if (!React.isValidElement(child)) continue
    if (child.type === 'input') return child as React.ReactElement<CheckboxProps>
    const nested = findCheckbox((child.props as { children?: React.ReactNode }).children)
    if (nested) return nested
  }
  return undefined
}

function checkboxFromComponent(): React.ReactElement<CheckboxProps> {
  const checkbox = findCheckbox(AgentSearchFootprintMemoryConsent())
  if (!checkbox) throw new Error('Consent checkbox is not available')
  return checkbox
}

function response(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

describe('AgentSearchFootprintMemoryConsent', () => {
  beforeEach(() => {
    hookState.overrides = null
    hookState.setters = []
    localeState.lang = 'en'
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('explains user-authorized advisory use and keeps the control closed while loading', () => {
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)
    expect(html).toContain('With consent enabled, future Sessions may refer to bounded role, location, and ATS source criteria from earlier Sessions')
    expect(html).toContain('not evidence about current search results')
    expect(html).toContain('this switch shows the saved choice')
    expect(html).toContain('Each objective still requires a fresh search')
    expect(html).toContain('separate from Task History')
    expect(html).toContain('grants no tools, approvals, or authority to act, apply, submit, or contact employers')
    expect(html).toContain('Re-enabling does not restore access for Sessions created under an earlier consent version')
    expect(html).toContain('aria-label="Allow future Sessions to refer to bounded search criteria"')
    expect(html).toContain('>Loading…</label>')
    expect(html).not.toContain('checked=""')
    expect(html).toContain('disabled=""')
  })

  it('renders the full consent scope and accessible control label in Chinese', () => {
    localeState.lang = 'zh'
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)

    expect(html).toContain('搜索条件记忆')
    expect(html).toContain('未来会话在有可用数据时，可参考早前会话中有限的职位、地点及 ATS 来源条件')
    expect(html).toContain('不是当前搜索结果的证据')
    expect(html).toContain('此开关显示已保存的选择')
    expect(html).toContain('每个目标仍需重新搜索')
    expect(html).toContain('此设置独立于任务历史')
    expect(html).toContain('不会授予工具、审批或执行操作、申请、提交或联系雇主的权限')
    expect(html).toContain('关闭后会阻止后续读取')
    expect(html).toContain('aria-label="允许未来会话参考有限的搜索条件"')
    expect(html).toContain('>正在加载…</label>')
  })

  it.each([
    ['loadFailed', '无法加载此设置，请重试。'],
    ['saveFailed', '无法确认这次更改，请重试。'],
    ['conflict', '此设置已在其他位置更改，现显示最新保存的选择。'],
    ['versionExhausted', '此选择已达到版本上限。若当前已开启，仍可关闭；关闭后无法再次开启。'],
  ] as const)('renders the Chinese %s status from a semantic message key', (message, localizedCopy) => {
    localeState.lang = 'zh'
    hookState.overrides = [message === 'loadFailed' ? null : { enabled: false, version: 4 }, false, false, message]
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)

    expect(html).toContain(localizedCopy)
    if (message === 'loadFailed') expect(html).toContain('>重试</button>')
  })

  it('does not claim the saved choice is unchanged when a save response is uncertain', () => {
    hookState.overrides = [{ enabled: false, version: 4 }, false, false, 'saveFailed']
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)

    expect(html).toContain('We couldn&#x27;t confirm this change. Please try again.')
    expect(html).not.toContain('Your saved choice has not changed')
  })

  it('localizes the enabled and revoked states without changing the consent value', () => {
    localeState.lang = 'zh'
    hookState.overrides = [{ enabled: true, version: 4 }, false, false, null]
    const enabled = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)
    expect(enabled).toContain('aria-label="允许未来会话参考有限的搜索条件"')
    expect(enabled).toContain('checked=""')
    expect(enabled).toContain('>已开启</label>')

    hookState.overrides = [{ enabled: false, version: 5 }, false, false, null]
    const revoked = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)
    expect(revoked).not.toContain('checked=""')
    expect(revoked).toContain('>已关闭</label>')
  })

  it('changes copy during a pending save without toggling or restarting the request', async () => {
    hookState.overrides = [{ enabled: false, version: 4 }, false, false, null]
    let resolveResponse: ((value: ReturnType<typeof response>) => void) | undefined
    const pendingResponse = new Promise<ReturnType<typeof response>>(resolve => { resolveResponse = resolve })
    const fetchMock = vi.fn(() => pendingResponse)
    vi.stubGlobal('fetch', fetchMock)
    checkboxFromComponent().props.onChange({ currentTarget: { checked: true } })
    expect(fetchMock).toHaveBeenCalledOnce()

    localeState.lang = 'zh'
    hookState.overrides = [{ enabled: false, version: 4 }, false, true, null]
    const pendingHtml = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)
    expect(pendingHtml).toContain('aria-label="允许未来会话参考有限的搜索条件"')
    expect(pendingHtml).toContain('>已关闭</label>')
    expect(pendingHtml).toContain('disabled=""')
    expect(fetchMock).toHaveBeenCalledOnce()

    resolveResponse?.(response(200, { enabled: true, version: 5 }))
    await vi.waitFor(() => expect(hookState.setters[0]).toHaveBeenCalledWith({ enabled: true, version: 5 }))
  })

  it('keeps the loaded default-off choice interactive', () => {
    hookState.overrides = [{ enabled: false, version: 0 }, false, false, null]
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)

    expect(html).toContain('<input')
    expect(html).toContain('>Off</label>')
    expect(html).not.toContain('checked=""')
    expect(html).not.toContain('disabled=""')
  })

  it('allows an enabled exhausted choice to be turned off once', async () => {
    hookState.overrides = [{ enabled: true, version: MAX_CONSENT_VERSION }, false, false, null]
    const fetchMock = vi.fn(async () => response(200, { enabled: false, version: MAX_CONSENT_VERSION }))
    vi.stubGlobal('fetch', fetchMock)
    const checkbox = checkboxFromComponent()
    hookState.overrides = [{ enabled: true, version: MAX_CONSENT_VERSION }, false, false, null]
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)

    expect(html).toContain('Search history is unavailable at this version limit. You can turn off the saved choice')
    expect(checkbox.props.checked).toBe(true)
    expect(checkbox.props.disabled).toBe(false)
    expect(html).toContain('>On (unavailable)</label>')
    checkbox.props.onChange({ currentTarget: { checked: false } })
    await vi.waitFor(() => expect(hookState.setters[0]).toHaveBeenCalledWith({ enabled: false, version: MAX_CONSENT_VERSION }))
    expect(fetchMock).toHaveBeenCalledWith('/api/me/agent-search-footprint-memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, expectedVersion: MAX_CONSENT_VERSION }),
    })

    hookState.overrides = [{ enabled: false, version: MAX_CONSENT_VERSION }, false, false, null]
    const disabledCheckbox = checkboxFromComponent()
    hookState.overrides = [{ enabled: false, version: MAX_CONSENT_VERSION }, false, false, null]
    const disabledHtml = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)
    expect(disabledHtml).toContain('this choice is off. It cannot be turned on again')
    expect(disabledCheckbox.props.checked).toBe(false)
    expect(disabledCheckbox.props.disabled).toBe(true)
    expect(html).not.toContain('This setting changed elsewhere')
  })

  it('keeps the normal toggle available immediately below the version limit', () => {
    hookState.overrides = [{ enabled: true, version: MAX_CONSENT_VERSION - 1 }, false, false, null]
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)

    expect(html).toContain('<input')
    expect(html).toContain('checked=""')
    expect(html).toContain('>On</label>')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('Search history is unavailable')
  })

  it('accepts a valid 200 choice update', async () => {
    hookState.overrides = [{ enabled: false, version: 4 }, false, false, null]
    const fetchMock = vi.fn(async () => response(200, { enabled: true, version: 5 }))
    vi.stubGlobal('fetch', fetchMock)
    checkboxFromComponent().props.onChange({ currentTarget: { checked: true } })

    await vi.waitFor(() => expect(hookState.setters[0]).toHaveBeenCalledWith({ enabled: true, version: 5 }))
    expect(fetchMock).toHaveBeenCalledWith('/api/me/agent-search-footprint-memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, expectedVersion: 4 }),
    })
  })

  it('keeps an exhausted opt-out locked off after a rejected re-enable response', async () => {
    hookState.overrides = [{ enabled: false, version: MAX_CONSENT_VERSION }, false, false, null]
    vi.stubGlobal('fetch', vi.fn(async () => response(409, {
      error: 'VERSION_EXHAUSTED', enabled: false, version: MAX_CONSENT_VERSION,
    })))
    checkboxFromComponent().props.onChange({ currentTarget: { checked: true } })

    await vi.waitFor(() => expect(hookState.setters[0]).toHaveBeenCalledWith({ enabled: false, version: MAX_CONSENT_VERSION }))
    expect(hookState.setters[3]).toHaveBeenCalledWith('versionExhausted')
    hookState.overrides = [{ enabled: false, version: MAX_CONSENT_VERSION }, false, false, 'versionExhausted']
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)
    expect(html).toContain('Search history is unavailable')
    expect(html).toContain('<input')
    expect(checkboxFromComponent().props.disabled).toBe(true)
  })

  it.each([
    ['unknown error code', { error: 'UNRECOGNIZED', enabled: true, version: MAX_CONSENT_VERSION }],
    ['invalid consent version', { error: 'VERSION_CONFLICT', enabled: true, version: MAX_CONSENT_VERSION + 1 }],
    ['missing error code', { enabled: true, version: 5 }],
  ])('rejects a 409 response with %s', async (_label, body) => {
    hookState.overrides = [{ enabled: false, version: 4 }, false, false, null]
    vi.stubGlobal('fetch', vi.fn(async () => response(409, body)))
    checkboxFromComponent().props.onChange({ currentTarget: { checked: true } })

    await vi.waitFor(() => expect(hookState.setters[3]).toHaveBeenCalledWith('saveFailed'))
    expect(hookState.setters[0]).not.toHaveBeenCalled()
  })

  it('reports a valid non-exhausted version conflict as a change elsewhere', async () => {
    hookState.overrides = [{ enabled: false, version: 4 }, false, false, null]
    vi.stubGlobal('fetch', vi.fn(async () => response(409, {
      error: 'VERSION_CONFLICT', enabled: true, version: 5,
    })))
    checkboxFromComponent().props.onChange({ currentTarget: { checked: true } })

    await vi.waitFor(() => expect(hookState.setters[3]).toHaveBeenCalledWith('conflict'))
    expect(hookState.setters[0]).toHaveBeenCalledWith({ enabled: true, version: 5 })
  })
})
