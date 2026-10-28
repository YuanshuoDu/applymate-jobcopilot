import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const language = vi.hoisted(() => ({ value: 'en' }))
vi.mock('@/lib/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ lang: language.value, t: (key: string) => key }),
}))

import { AgentTaskWaitDetailsContent } from './AgentTaskWaitDetailsCard'
import type { AgentTaskWaitState } from './use-agent-task-wait'

const wait: NonNullable<AgentTaskWaitState['wait']> = {
  mode: 'any', status: 'waiting', deadlineAt: '2026-10-27T12:00:00.000Z', parentDeadlineAt: '2026-10-27T12:30:00.000Z',
  targets: [
    { taskId: 'child-a', label: 'Researcher', status: 'completed', matched: true },
    { taskId: 'child-b', label: null, status: 'running', matched: false },
  ],
}
const state = (phase: AgentTaskWaitState['phase'], value: AgentTaskWaitState['wait'] = null): AgentTaskWaitState => ({
  phase, loading: phase === 'checking', wait: value, due: null,
})

describe('AgentTaskWaitDetailsContent', () => {
  it('renders mode, deadline, status, match state, and only selects targets already in the tree', () => {
    const html = renderToStaticMarkup(<AgentTaskWaitDetailsContent
      state={{ ...state('available', wait), due: 'wait' }} selectedTaskId="child-b"
      taskNodeIds={new Set(['child-a'])} onSelectTarget={vi.fn()}
    />)
    expect(html).toContain('Any child')
    expect(html).toContain('Wait deadline reached')
    expect(html).toContain('Task deadline')
    expect(html).toContain('dateTime="2026-10-27T12:30:00.000Z"')
    expect(html).toContain('Waiting')
    expect(html).toContain('Researcher')
    expect(html).toContain('Matched')
    expect(html).toContain('Not matched')
    expect(html).toContain('Child')
    expect(html).toContain('aria-label="Select Researcher"')
    expect(html).not.toContain('aria-label="Select Child"')
    expect(html).toContain('data-wait-target-matched="true"')
    expect(html).toContain('data-wait-target-matched="false"')
  })

  it('renders all-mode and neutral empty, unavailable, and error states', () => {
    language.value = 'zh'
    const all = renderToStaticMarkup(<AgentTaskWaitDetailsContent
      state={{ ...state('available', { ...wait, mode: 'all' }) }} taskNodeIds={new Set()} onSelectTarget={vi.fn()}
    />)
    expect(all).toContain('所有子任务')
    expect(all).toContain('子任务')
    expect(all).not.toContain('<button')
    expect(renderToStaticMarkup(<AgentTaskWaitDetailsContent state={state('empty')} taskNodeIds={new Set()} onSelectTarget={vi.fn()} />)).toContain('当前没有等待中的子任务。')
    expect(renderToStaticMarkup(<AgentTaskWaitDetailsContent state={state('unavailable')} taskNodeIds={new Set()} onSelectTarget={vi.fn()} />)).toContain('等待详情不可用。')
    expect(renderToStaticMarkup(<AgentTaskWaitDetailsContent state={state('error')} taskNodeIds={new Set()} onSelectTarget={vi.fn()} />)).toContain('无法加载等待详情。')
    expect(renderToStaticMarkup(<AgentTaskWaitDetailsContent
      state={state('available', { ...wait, parentDeadlineAt: null })} taskNodeIds={new Set()} onSelectTarget={vi.fn()}
    />)).toContain('未记录任务总截止时间')
    language.value = 'en'
  })
})
