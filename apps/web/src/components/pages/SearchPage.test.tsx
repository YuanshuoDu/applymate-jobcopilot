import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('@/lib/nav-context', () => ({ useNav: () => ({ navigate: mocks.navigate }) }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/jobs/SmartSearch', () => ({ SmartSearch: () => null }))
vi.mock('@/components/layout/TopBar', () => ({ TopBar: () => null }))
vi.mock('@/components/ui', () => ({ Btn: () => null }))

import { SearchPage } from './SearchPage'
import { SmartSearch } from '@/components/jobs/SmartSearch'

function elements(value: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!React.isValidElement<Record<string, unknown>>(value)) return []
  return [value, ...elements(value.props.children as React.ReactNode)]
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('Discover application navigation', () => {
  it('uses the saved database job ID and retains existing list context', () => {
    const replaceState = vi.fn()
    const postMessage = vi.fn()
    vi.stubGlobal('window', {
      location: { href: 'https://applymate.example/?page=search&jobsPage=3#saved', origin: 'https://applymate.example' },
      history: { state: { preserved: true }, replaceState }, postMessage, dispatchEvent: vi.fn(),
    })
    const search = elements(SearchPage()).find(element => element.type === SmartSearch)!
    ;(search.props.onJobSaved as (jobId: string) => void)('database-job-81')
    expect(postMessage).toHaveBeenCalledWith({ type: 'job-saved' }, 'https://applymate.example')
    expect(mocks.navigate).not.toHaveBeenCalled()
    ;(search.props.onOpenApplication as (jobId: string) => void)('database-job-81')
    const destination = new URL(replaceState.mock.calls[0][2])
    expect(destination.searchParams.get('highlight')).toBe('database-job-81')
    expect(destination.searchParams.get('jobsPage')).toBe('3')
    expect(destination.hash).toBe('#saved')
    expect(mocks.navigate).toHaveBeenCalledWith('jobs')
  })
})
