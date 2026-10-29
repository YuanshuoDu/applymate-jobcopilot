import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const language = vi.hoisted(() => ({ value: 'en' }))
const hookState = vi.hoisted(() => ({ overrides: null as unknown[] | null }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: language.value }) }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useEffect: () => undefined,
    useState: (initial: unknown) => {
      const value = hookState.overrides?.shift()
      return [value === undefined ? initial : value, vi.fn()]
    },
  }
})

import {
  AgentTaskHistoryMemoryConsent,
  agentTaskHistoryMemoryConsentRequestBody,
  parseAgentTaskHistoryMemoryConsent,
  parseAgentTaskHistoryMemorySaveResponse,
} from './AgentTaskHistoryMemoryConsent'

describe('AgentTaskHistoryMemoryConsent', () => {
  beforeEach(() => {
    language.value = 'en'
    hookState.overrides = null
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('keeps consent disabled until the authenticated setting has loaded', () => {
    const html = renderToStaticMarkup(<AgentTaskHistoryMemoryConsent />)

    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Loading your saved choice')
  })

  it('explains scope, service availability, revocation, and action limits before opt-in', () => {
    const html = renderToStaticMarkup(<AgentTaskHistoryMemoryConsent />)

    expect(html).toContain('historical terminal outcomes from completed Root TaskGraphs')
    expect(html).toContain('does not cover all Agent tasks or activity')
    expect(html).toContain('same verified objective, origin, and intent')
    expect(html).toContain('advisory only')
    expect(html).toContain('depends on the server rollout')
    expect(html).toContain('new Sessions from receiving memory permission')
    expect(html).toContain('already pinned a choice keeps it')
    expect(html).toContain('cannot be recalled')
    expect(html).toContain('no tool, approval, credential, application, send, submit, or other action authority')
  })

  it('renders the Chinese disclosure for Chinese users', () => {
    language.value = 'zh'
    const html = renderToStaticMarkup(<AgentTaskHistoryMemoryConsent />)

    expect(html).toContain('先前已完成 Root TaskGraph 的历史终态结果')
    expect(html).toContain('不涵盖所有 Agent 任务或活动')
    expect(html).toContain('同一已验证目标、来源和意图')
    expect(html).toContain('服务端的发布状态')
    expect(html).toContain('已发送给 AI 服务商的信息无法撤回')
  })

  it('accepts only a boolean choice and a nonnegative safe version', () => {
    expect(parseAgentTaskHistoryMemoryConsent({ enabled: false, version: 0 })).toEqual({ enabled: false, version: 0 })
    expect(parseAgentTaskHistoryMemoryConsent({ enabled: true, version: 3 })).toEqual({ enabled: true, version: 3 })
    expect(parseAgentTaskHistoryMemoryConsent({ enabled: true, version: -1 })).toBeNull()
    expect(parseAgentTaskHistoryMemoryConsent({ enabled: true, version: 1.5 })).toBeNull()
    expect(parseAgentTaskHistoryMemoryConsent({ enabled: 'true', version: 1 })).toBeNull()
  })

  it('sends only the explicit choice and expected consent version', () => {
    expect(agentTaskHistoryMemoryConsentRequestBody(true, 7)).toEqual({ enabled: true, expectedVersion: 7 })
  })

  it('adopts the current server choice on a CAS conflict without retrying the write', () => {
    expect(parseAgentTaskHistoryMemorySaveResponse(409, {
      error: 'VERSION_CONFLICT', enabled: false, version: 8,
    })).toEqual({ kind: 'conflict', consent: { enabled: false, version: 8 } })
    expect(parseAgentTaskHistoryMemorySaveResponse(409, {
      error: 'VERSION_EXHAUSTED', enabled: true, version: 2_147_483_647,
    })).toEqual({ kind: 'version-exhausted', consent: { enabled: true, version: 2_147_483_647 } })
    expect(parseAgentTaskHistoryMemorySaveResponse(409, {
      error: 'VERSION_CONFLICT', enabled: 'true', version: 8,
    })).toEqual({ kind: 'invalid' })
  })

  it('disables the switch and sends no request at the maximum Int32 consent version', () => {
    hookState.overrides = [
      { enabled: true, version: 2_147_483_647 }, false, false, null, null,
    ]
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const section = AgentTaskHistoryMemoryConsent() as React.ReactElement<{ children?: React.ReactNode }>
    const [header] = React.Children.toArray(section.props.children) as React.ReactElement<{ children?: React.ReactNode }>[]
    const [, button] = React.Children.toArray(header.props.children) as React.ReactElement<{
      disabled: boolean
      onClick: () => void
    }>[]

    expect(button.props.disabled).toBe(true)
    button.props.onClick()
    expect(request).not.toHaveBeenCalled()
  })
})
