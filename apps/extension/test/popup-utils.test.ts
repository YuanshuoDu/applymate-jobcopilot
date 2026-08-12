import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCurrentSidePanel, openSidePanel } from '../src/popup/popup-utils'

const originalChrome = globalThis.chrome

function installChromeMock() {
  const mock = {
    windows: { WINDOW_ID_CURRENT: -2 },
    tabs: {
      query: vi.fn(() => { throw new Error('active-tab query should not be needed to open Side Panel') }),
      create: vi.fn(),
    },
    storage: { local: { set: vi.fn(() => Promise.resolve()) } },
    runtime: { sendMessage: vi.fn(() => Promise.resolve({ ok: true })) },
    sidePanel: { open: vi.fn(() => Promise.resolve()) },
  }
  Object.assign(globalThis, { chrome: mock })
  return mock
}

afterEach(() => { Object.assign(globalThis, { chrome: originalChrome }) })

describe('popup Side Panel navigation', () => {
  it('opens the native panel in the current window without querying or creating a tab', async () => {
    const chromeMock = installChromeMock()
    await openCurrentSidePanel('resume')
    expect(chromeMock.tabs.query).not.toHaveBeenCalled()
    expect(chromeMock.tabs.create).not.toHaveBeenCalled()
    expect(chromeMock.sidePanel.open).toHaveBeenCalledWith({ windowId: -2 })
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OPEN_SIDE_PANEL_TAB', tab: 'resume' })
  })

  it('persists the requested destination before opening the native panel', async () => {
    const chromeMock = installChromeMock()
    await openSidePanel(42, 'jobs')
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({ pendingSidePanelTab: expect.objectContaining({ tab: 'jobs' }) }))
    expect(chromeMock.sidePanel.open).toHaveBeenCalledWith({ windowId: 42 })
  })
})
