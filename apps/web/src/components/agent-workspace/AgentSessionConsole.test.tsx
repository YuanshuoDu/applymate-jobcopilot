import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionConsole } from './AgentSessionConsole'
import type { AgentSessionSummary } from './session-view-model'

const mocks = vi.hoisted(() => ({ sessions: [] as AgentSessionSummary[], refetch: vi.fn(), focus: vi.fn() }))
vi.mock('@/lib/hooks', () => ({ useApi: () => ({ data: { sessions: mocks.sessions, lastOpenedSessionId: null }, loading: false, error: null, refetch: mocks.refetch }) }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('./SessionFocusPanel', () => ({ SessionFocusPanel: (props: unknown) => { mocks.focus(props); return null } }))
vi.mock('./AgentSessionTools', () => ({ AgentSessionTools: () => <div>Session tools</div> }))

function session(id: string, status: string): AgentSessionSummary {
  return { id, status, goal: `Conversation ${id}`, source: 'user', memorySummary: '', qualityScore: null, currentTaskId: null, createdAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T10:00:00Z', completedAt: null }
}

function renderConsole() {
  return renderToStaticMarkup(<AgentSessionConsole selectedSessionId="done" onSelectSession={vi.fn()} onNewChat={vi.fn()} onDeletedSession={vi.fn()} />)
}

describe('AgentSessionConsole focus', () => {
  beforeEach(() => { mocks.sessions = []; mocks.refetch.mockClear(); mocks.focus.mockClear() })
  afterEach(() => vi.restoreAllMocks())

  it('uses a full-width readable filter and omits zero count tiles', () => {
    mocks.sessions = [session('done', 'completed')]
    const html = renderConsole()
    expect(html).toContain('aria-label="agent.filterSessions"')
    expect(html).not.toContain('grid-template-columns:1fr 40px')
    expect(html).not.toContain('agent.queuedTasks')
    expect(html).not.toContain('agent.approvals')
    expect(html).not.toContain('0 agent.runningSessions')
    expect(html).not.toContain('0 agent.needsAttention')
    expect(html).toContain('Conversation done')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="agent.delete Conversation done"')
    expect(html).not.toContain('quality pending')
    expect(html).not.toContain('quality 95%')
  })

  it('keeps conversation context concise even when internal scores and memory are available', () => {
    mocks.sessions = [{ ...session('done', 'completed'), qualityScore: 95, memorySummary: 'Internal memory summary' }]
    const html = renderConsole()
    expect(html).toContain('Conversation done')
    expect(html).not.toContain('quality 95%')
    expect(html).not.toContain('Internal memory summary')
  })

  it('counts running and attention sessions accurately without treating waiting as approvals', () => {
    mocks.sessions = [session('running', 'running'), session('waiting', 'waiting_for_user'), session('failed', 'failed'), session('paused', 'paused'), session('done', 'completed')]
    const html = renderConsole()
    expect(html).toMatch(/<button[^>]*>1 agent.runningSessions<\/button>/)
    expect(html).toMatch(/<button[^>]*>2 agent.needsAttention<\/button>/)
    expect(html).not.toContain('agent.approvals')
    for (const item of mocks.sessions) expect(html).toContain(item.goal)
  })

  it('makes count shortcuts select their filters and preserves session selection and new-chat actions', () => {
    mocks.sessions = [session('running', 'running'), session('waiting', 'waiting_for_user')]
    const setState = vi.fn()
    vi.spyOn(React, 'useState').mockImplementation(((initial?: unknown) => [initial, setState]) as typeof React.useState)
    vi.spyOn(React, 'useEffect').mockImplementation(() => undefined)
    const onSelectSession = vi.fn()
    const onNewChat = vi.fn()
    const tree = AgentSessionConsole({ selectedSessionId: null, onSelectSession, onNewChat, onDeletedSession: vi.fn() })
    const buttons = findButtons(tree)
    buttons.find(button => React.Children.toArray(button.props.children).includes('agent.runningSessions'))!.props.onClick!()
    expect(setState).toHaveBeenLastCalledWith('running')
    buttons.find(button => React.Children.toArray(button.props.children).includes('agent.needsAttention'))!.props.onClick!()
    expect(setState).toHaveBeenLastCalledWith('needs_attention')
    buttons.find(button => textContent(button).includes('Conversation waiting') && button.props['aria-pressed'] !== undefined)!.props.onClick!()
    expect(onSelectSession).toHaveBeenCalledWith('waiting', 'Conversation waiting', expect.any(String))
    buttons.find(button => textContent(button).includes('agent.newChat'))!.props.onClick!()
    expect(onNewChat).toHaveBeenCalledOnce()
  })

  it('filters attention to waiting or failed sessions without losing the full-list option', () => {
    mocks.sessions = [session('running', 'running'), session('waiting', 'waiting_for_user'), session('failed', 'failed'), session('done', 'completed')]
    vi.spyOn(React, 'useState').mockReturnValueOnce(['needs_attention', vi.fn()])
    const html = renderConsole()
    expect(html).toContain('Conversation waiting')
    expect(html).toContain('Conversation failed')
    expect(html).not.toContain('Conversation running')
    expect(html).not.toContain('Conversation done')
    expect(html).toContain('agent.viewAll')
  })

  it('forwards selected-session attention without wrapping the workspace callback', () => {
    const onAttentionChange = vi.fn()
    renderToStaticMarkup(<AgentSessionConsole selectedSessionId="done" onSelectSession={vi.fn()} onNewChat={vi.fn()} onDeletedSession={vi.fn()} onAttentionChange={onAttentionChange} />)
    expect(mocks.focus).toHaveBeenCalledWith({ sessionId: 'done', onAttentionChange })
    expect(onAttentionChange).not.toHaveBeenCalled()
  })
})

type ButtonElement = React.ReactElement<{ children?: React.ReactNode; onClick?: () => void; 'aria-pressed'?: boolean }>
function findButtons(node: React.ReactNode): ButtonElement[] {
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return []
  return [...(node.type === 'button' ? [node as ButtonElement] : []), ...React.Children.toArray(node.props.children).flatMap(findButtons)]
}
function textContent(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return ''
  return React.Children.toArray(node.props.children).map(textContent).join(' ')
}
