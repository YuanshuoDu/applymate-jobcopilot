import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hookState = vi.hoisted(() => ({
  overrides: null as unknown[] | null,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
}))
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
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('explains user-authorized advisory use and keeps the control closed while loading', () => {
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)
    expect(html).toContain('With your consent enabled, future sessions may refer to bounded role, location, and source criteria from earlier sessions as advisory context')
    expect(html).toContain('Each objective still requires a fresh search')
    expect(html).toContain('Separate from Task History')
    expect(html).toContain('grants no action, approval, or submission authority')
    expect(html).toContain('aria-label="Allow future sessions to refer to bounded search criteria"')
    expect(html).toContain('>Loading…</label>')
    expect(html).not.toContain('checked=""')
    expect(html).toContain('disabled=""')
  })

  it('keeps the loaded default-off choice interactive', () => {
    hookState.overrides = [{ enabled: false, version: 0 }, false, false, '']
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)

    expect(html).toContain('<input')
    expect(html).toContain('>Off</label>')
    expect(html).not.toContain('checked=""')
    expect(html).not.toContain('disabled=""')
  })

  it('allows an enabled exhausted choice to be turned off once', async () => {
    hookState.overrides = [{ enabled: true, version: MAX_CONSENT_VERSION }, false, false, '']
    const fetchMock = vi.fn(async () => response(200, { enabled: false, version: MAX_CONSENT_VERSION }))
    vi.stubGlobal('fetch', fetchMock)
    const checkbox = checkboxFromComponent()
    hookState.overrides = [{ enabled: true, version: MAX_CONSENT_VERSION }, false, false, '']
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)

    expect(html).toContain('Search history is unavailable. You can turn off the saved choice here')
    expect(checkbox.props.checked).toBe(true)
    expect(checkbox.props.disabled).toBe(false)
    expect(html).toContain('>On (unavailable)</label>')
    checkbox.props.onChange({ currentTarget: { checked: false } })
    await vi.waitFor(() => expect(hookState.setters[0]).toHaveBeenCalledWith({ enabled: false, version: MAX_CONSENT_VERSION }))
    expect(fetchMock).toHaveBeenCalledWith('/api/me/agent-search-footprint-memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, expectedVersion: MAX_CONSENT_VERSION }),
    })

    hookState.overrides = [{ enabled: false, version: MAX_CONSENT_VERSION }, false, false, '']
    const disabledCheckbox = checkboxFromComponent()
    hookState.overrides = [{ enabled: false, version: MAX_CONSENT_VERSION }, false, false, '']
    const disabledHtml = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)
    expect(disabledHtml).toContain('this choice is off. It cannot be turned on again')
    expect(disabledCheckbox.props.checked).toBe(false)
    expect(disabledCheckbox.props.disabled).toBe(true)
    expect(html).not.toContain('This setting changed elsewhere')
  })

  it('keeps the normal toggle available immediately below the version limit', () => {
    hookState.overrides = [{ enabled: true, version: MAX_CONSENT_VERSION - 1 }, false, false, '']
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)

    expect(html).toContain('<input')
    expect(html).toContain('checked=""')
    expect(html).toContain('>On</label>')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('Search history is unavailable')
  })

  it('accepts a valid 200 choice update', async () => {
    hookState.overrides = [{ enabled: false, version: 4 }, false, false, '']
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
    hookState.overrides = [{ enabled: false, version: MAX_CONSENT_VERSION }, false, false, '']
    vi.stubGlobal('fetch', vi.fn(async () => response(409, {
      error: 'VERSION_EXHAUSTED', enabled: false, version: MAX_CONSENT_VERSION,
    })))
    checkboxFromComponent().props.onChange({ currentTarget: { checked: true } })

    await vi.waitFor(() => expect(hookState.setters[0]).toHaveBeenCalledWith({ enabled: false, version: MAX_CONSENT_VERSION }))
    expect(hookState.setters[3]).not.toHaveBeenCalledWith('This setting changed elsewhere. The latest saved choice is shown.')
    hookState.overrides = [{ enabled: false, version: MAX_CONSENT_VERSION }, false, false, '']
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
    hookState.overrides = [{ enabled: false, version: 4 }, false, false, '']
    vi.stubGlobal('fetch', vi.fn(async () => response(409, body)))
    checkboxFromComponent().props.onChange({ currentTarget: { checked: true } })

    await vi.waitFor(() => expect(hookState.setters[3]).toHaveBeenCalledWith('Could not save this setting. Try again.'))
    expect(hookState.setters[0]).not.toHaveBeenCalled()
  })

  it('reports a valid non-exhausted version conflict as a change elsewhere', async () => {
    hookState.overrides = [{ enabled: false, version: 4 }, false, false, '']
    vi.stubGlobal('fetch', vi.fn(async () => response(409, {
      error: 'VERSION_CONFLICT', enabled: true, version: 5,
    })))
    checkboxFromComponent().props.onChange({ currentTarget: { checked: true } })

    await vi.waitFor(() => expect(hookState.setters[3]).toHaveBeenCalledWith('This setting changed elsewhere. The latest saved choice is shown.'))
    expect(hookState.setters[0]).toHaveBeenCalledWith({ enabled: true, version: 5 })
  })
})
