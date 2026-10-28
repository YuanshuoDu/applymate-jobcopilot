import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentWorkspacePanels } from './AgentWorkspacePanels'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Agent workspace progressive disclosure', () => {
  it('gives conversation the default space while retaining mounted detail content', () => {
    const html = renderToStaticMarkup(<AgentWorkspacePanels sessionId="session-a" needsAttention={false}
      toolbar={<button>Find jobs</button>} details={<textarea defaultValue="Preserved draft" />}>
      <main>Conversation</main>
    </AgentWorkspacePanels>)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/id="agent-workspace-details"[^>]*hidden=""/)
    expect(html).toContain('Preserved draft')
    expect(html).toContain('Tasks &amp; results')
    expect(html).toContain('<main>Conversation</main>')
  })

  it('keeps required action discoverable even while details are closed', () => {
    const html = renderToStaticMarkup(<AgentWorkspacePanels sessionId="session-a" needsAttention
      toolbar={null} details={<button>Approve</button>}>Conversation</AgentWorkspacePanels>)
    expect(html.indexOf('Needs attention')).toBeLessThan(html.indexOf('id="agent-workspace-details"'))
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-controls="agent-workspace-details"')
  })

  it('has no irrelevant task entry for a new conversation', () => {
    const html = renderToStaticMarkup(<AgentWorkspacePanels sessionId={null} needsAttention={false}
      toolbar={<button>Find jobs</button>} details={null}>Welcome</AgentWorkspacePanels>)
    expect(html).not.toContain('aria-controls="agent-workspace-details"')
    expect(html).toContain('Find jobs')
    expect(html).toContain('Welcome')
  })
})

function panelTransition(previous: { sessionId: string | null; open: boolean }, sessionId: string | null, open = false) {
  const callbacks = new Map<number, FrameRequestCallback>()
  const requestFrame = vi.fn((callback: FrameRequestCallback) => { callbacks.set(1, callback); return 1 })
  const cancelFrame = vi.fn((id: number) => { callbacks.delete(id) })
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  const target = { dataset: { agentHarnessItem: 'selected-tool' }, scrollIntoView: vi.fn() }
  const other = { dataset: { agentHarnessItem: 'other-tool' }, scrollIntoView: vi.fn() }
  const workspace = {
    dataset: { agentWorkspaceSession: sessionId },
    querySelector: vi.fn(() => ({ dataset: { taskTimelineItem: 'selected-tool' } })),
    querySelectorAll: vi.fn(() => [other, target]),
  }
  const effects: React.EffectCallback[] = []
  vi.spyOn(React, 'useEffect').mockImplementation(effect => { effects.push(effect) })
  vi.spyOn(React, 'useState').mockReturnValue([{ sessionId, open }, vi.fn()])
  vi.spyOn(React, 'useRef').mockReturnValueOnce({ current: null })
    .mockReturnValueOnce({ current: workspace }).mockReturnValueOnce({ current: previous })
  renderToStaticMarkup(<AgentWorkspacePanels sessionId={sessionId} needsAttention={false}
    toolbar={null} details={null}>Conversation</AgentWorkspacePanels>)
  const cleanup = effects[0]!()
  return { target, other, workspace, requestFrame, cancelFrame, cleanup, paint: () => {
    for (const callback of callbacks.values()) callback(0)
    callbacks.clear()
  } }
}

describe('Returning to selected evidence', () => {
  it('locates current evidence after the wider conversation has reflowed, without changing focus', () => {
    const view = panelTransition({ sessionId: 'session-a', open: true }, 'session-a')
    expect(view.requestFrame).toHaveBeenCalledOnce()
    expect(view.workspace.querySelectorAll).not.toHaveBeenCalled()
    expect(view.target.scrollIntoView).not.toHaveBeenCalled()
    // A replay/reflow can replace the target before the next frame; resolve the current DOM then.
    const reflowedTarget = { dataset: { agentHarnessItem: 'selected-tool' }, scrollIntoView: vi.fn(), focus: vi.fn() }
    view.workspace.querySelectorAll.mockReturnValue([view.other, reflowedTarget])
    view.paint()
    expect(reflowedTarget.scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant', block: 'center' })
    expect(reflowedTarget.focus).not.toHaveBeenCalled()
    expect(view.target.scrollIntoView).not.toHaveBeenCalled()
    expect(view.other.scrollIntoView).not.toHaveBeenCalled()
  })

  it.each([
    [{ sessionId: 'session-a', open: false }, 'session-a', false],
    [{ sessionId: 'session-a', open: false }, 'session-a', true],
    [{ sessionId: 'session-a', open: true }, 'session-b', false],
    [{ sessionId: 'session-a', open: true }, null, false],
  ] as const)('does not reposition for unchanged, opening, or different session views (%j)', (previous, sessionId, open) => {
    const view = panelTransition(previous, sessionId, open)
    expect(view.requestFrame).not.toHaveBeenCalled()
    expect(view.target.scrollIntoView).not.toHaveBeenCalled()
  })

  it('cancels pending positioning when the effect is disposed before paint', () => {
    const view = panelTransition({ sessionId: 'session-a', open: true }, 'session-a')
    if (typeof view.cleanup === 'function') view.cleanup()
    expect(view.cancelFrame).toHaveBeenCalledWith(1)
    view.paint()
    expect(view.target.scrollIntoView).not.toHaveBeenCalled()
  })

  it('rejects a reused item id after the rendered workspace changes session', () => {
    const view = panelTransition({ sessionId: 'session-a', open: true }, 'session-a')
    view.workspace.dataset.agentWorkspaceSession = 'session-b'
    view.paint()
    expect(view.workspace.querySelectorAll).not.toHaveBeenCalled()
    expect(view.target.scrollIntoView).not.toHaveBeenCalled()
  })

  it('does not move the transcript if the selected evidence is no longer present', () => {
    const view = panelTransition({ sessionId: 'session-a', open: true }, 'session-a')
    view.workspace.querySelectorAll.mockReturnValue([view.other])
    view.paint()
    expect(view.other.scrollIntoView).not.toHaveBeenCalled()
  })
})
