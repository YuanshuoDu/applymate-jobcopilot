import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertActivePage, loadSiteAccess, removeBroadSiteAccess, requestFrameInspection, requestSiteAccess, siteOriginPattern, type SiteAccessSnapshot } from './site-access'

const tab = { id: 7, url: 'https://careers.company.test/jobs/engineer' }
const frames = [
  { frameId: 0, parentFrameId: -1, documentId: 'main-doc', url: tab.url, documentLifecycle: 'active' },
  // URLs are what actually loaded after a redirect, not iframe.src guesses.
  { frameId: 21, parentFrameId: 0, documentId: 'redirected-doc', url: 'https://tenant.ats.test/application/2', documentLifecycle: 'active' },
  { frameId: 25, parentFrameId: 21, documentId: 'nested-doc', url: 'https://forms.other-ats.test/start', documentLifecycle: 'active' },
  { frameId: 26, parentFrameId: 0, documentId: 'ad-doc', url: 'https://ads.unrelated.test/render', documentLifecycle: 'active' },
  { frameId: 28, parentFrameId: 0, documentId: 'blank-doc', url: 'about:srcdoc', documentLifecycle: 'active' },
]

function chromeMock(inspect = false, granted: string[] = ['https://careers.company.test:443/*']) {
  return {
    permissions: {
      contains: vi.fn(async (query: { permissions?: string[]; origins?: string[] }) => query.permissions ? inspect : query.origins?.every(origin => granted.includes(origin)) ?? false),
      getAll: vi.fn(async () => ({ permissions: inspect ? ['webNavigation'] : [], origins: granted })),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    },
    webNavigation: { getAllFrames: vi.fn(async () => frames) },
    tabs: { query: vi.fn(async () => [tab]) },
  }
}

let browser: ReturnType<typeof chromeMock>
beforeEach(() => { browser = chromeMock(); vi.stubGlobal('chrome', browser) })
afterEach(() => vi.unstubAllGlobals())

describe('concrete site origin patterns', () => {
  it.each([
    ['https://tenant.example.test/job/7?session=private#step', 'https://tenant.example.test:443/*'],
    ['http://localhost:3000/extension-review', 'http://localhost:3000/*'],
    ['http://company.test/apply', 'http://company.test:80/*'],
    ['https://tenant.example.test:8443/apply', 'https://tenant.example.test:8443/*'],
    ['https://TENANT.example.test:443/apply', 'https://tenant.example.test:443/*'],
  ])('limits %s to its scheme, host and port', (url, expected) => {
    expect(siteOriginPattern(url)).toBe(expected)
  })

  it.each(['chrome://settings', 'chrome-extension://id/options.html', 'file:///private/resume.pdf', 'about:blank', 'data:text/html,form', 'blob:https://company.test/id', 'https://name:secret@company.test/apply', 'https://*/*', 'http://*.example.test/*', '<all_urls>', 'invalid'])('rejects unsupported or nonconcrete URLs: %s', url => {
    expect(siteOriginPattern(url)).toBeNull()
  })
})

describe('access snapshots for the current page', () => {
  it('does not inspect frames before the optional user grant', async () => {
    const snapshot = await loadSiteAccess(tab)
    expect(snapshot.frameInspection).toBe(false)
    expect(snapshot.frames).toEqual([{ frameId: 0, parentFrameId: -1, url: tab.url, origin: 'https://careers.company.test:443/*', granted: true }])
    expect(browser.webNavigation.getAllFrames).not.toHaveBeenCalled()
    expect(browser.permissions.request).not.toHaveBeenCalled()
  })

  it('uses actual redirected and nested frame URLs without requesting ad or other frame sites', async () => {
    browser = chromeMock(true)
    vi.stubGlobal('chrome', browser)
    const snapshot = await loadSiteAccess(tab)
    expect(browser.webNavigation.getAllFrames).toHaveBeenCalledExactlyOnceWith({ tabId: tab.id })
    expect(snapshot.frames.find(frame => frame.frameId === 21)).toMatchObject({ parentFrameId: 0, origin: 'https://tenant.ats.test:443/*', documentId: 'redirected-doc', granted: false })
    expect(snapshot.frames.find(frame => frame.frameId === 25)).toMatchObject({ parentFrameId: 21, origin: 'https://forms.other-ats.test:443/*', granted: false })
    expect(snapshot.frames.find(frame => frame.frameId === 26)?.granted).toBe(false)
    expect(snapshot.frames.find(frame => frame.frameId === 28)).toMatchObject({ origin: null, granted: false })
    expect(browser.permissions.request).not.toHaveBeenCalled()
  })

  it('warns and falls back to the main page when frame inspection is denied or revoked', async () => {
    browser = chromeMock(true)
    browser.webNavigation.getAllFrames.mockRejectedValue(new Error('Permission revoked'))
    vi.stubGlobal('chrome', browser)
    const snapshot = await loadSiteAccess(tab)
    expect(snapshot.warning).toBe('Permission revoked')
    expect(snapshot.frames.map(frame => frame.frameId)).toEqual([0])
  })

  it('does not present stale iframe origins after the main page has redirected', async () => {
    browser = chromeMock(true)
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { ...frames[0], url: 'https://another-company.test/careers', documentId: 'new-main' }, ...frames.slice(1),
    ])
    vi.stubGlobal('chrome', browser)
    const snapshot = await loadSiteAccess(tab)
    expect(snapshot.warning).toMatch(/page changed/)
    expect(snapshot.frames).toHaveLength(1)
  })

  it('ignores inactive BFCache and failed frames', async () => {
    browser = chromeMock(true)
    browser.webNavigation.getAllFrames.mockResolvedValue([
      frames[0], { ...frames[1], documentLifecycle: 'cached' }, { ...frames[2], errorOccurred: true },
    ] as typeof frames)
    vi.stubGlobal('chrome', browser)
    const snapshot = await loadSiteAccess(tab)
    expect(snapshot.frames.map(frame => frame.frameId)).toEqual([0])
  })
})

describe('user-gesture requests and previous broad permission', () => {
  let snapshot: SiteAccessSnapshot
  beforeEach(async () => { snapshot = await loadSiteAccess(tab) })

  it('calls request synchronously while still in the click turn and requests only the displayed origin', async () => {
    let inGesture = true
    browser.permissions.request.mockImplementation(async () => {
      expect(inGesture).toBe(true)
      return true
    })
    const granted = requestSiteAccess(snapshot, 'https://careers.company.test:443/*', snapshot)
    expect(browser.permissions.request).toHaveBeenCalledExactlyOnceWith({ origins: ['https://careers.company.test:443/*'] })
    expect(browser.tabs.query).not.toHaveBeenCalled()
    inGesture = false
    expect(await granted).toBe(true)
  })

  it('requires a separate synchronous opt-in before discovering embedded addresses', async () => {
    const granted = requestFrameInspection(snapshot, snapshot)
    expect(browser.permissions.request).toHaveBeenCalledExactlyOnceWith({ permissions: ['webNavigation'] })
    expect(await granted).toBe(true)
    expect(browser.webNavigation.getAllFrames).not.toHaveBeenCalled()
  })

  it('reports a declined grant without switching to a broader request', async () => {
    browser.permissions.request.mockResolvedValue(false)
    expect(await requestSiteAccess(snapshot, 'https://careers.company.test:443/*', snapshot)).toBe(false)
    expect(browser.permissions.request).toHaveBeenCalledTimes(1)
    expect(browser.webNavigation.getAllFrames).not.toHaveBeenCalled()
  })

  it('requires a fresh UI snapshot after active-tab or permission changes', () => {
    expect(() => requestSiteAccess(snapshot, 'https://careers.company.test:443/*', null)).toThrow(/active page changed/)
    expect(() => requestFrameInspection(snapshot, { ...snapshot })).toThrow(/active page changed/)
    expect(browser.permissions.request).not.toHaveBeenCalled()
  })

  it.each(['https://*/*', 'http://*/*', 'https://not-discovered.test/*', 'https://careers.company.test/other', 'https://careers.company.test/*'])('rejects broad or undiscovered request %s', origin => {
    expect(() => requestSiteAccess(snapshot, origin, snapshot)).toThrow(/specific site/)
    expect(browser.permissions.request).not.toHaveBeenCalled()
  })

  it('shows existing broad grants without revoking silently, and removes only those when asked', async () => {
    browser.permissions.getAll.mockResolvedValue({ permissions: [], origins: ['https://*/*', 'http://*/*', 'https://careers.company.test:443/*', 'https://applymate.site:443/*'] })
    const old = await loadSiteAccess(tab)
    expect(old.broadOrigins).toEqual(['https://*/*', 'http://*/*'])
    expect(browser.permissions.remove).not.toHaveBeenCalled()
    await removeBroadSiteAccess(old, old)
    expect(browser.permissions.remove).toHaveBeenCalledExactlyOnceWith({ origins: ['https://*/*', 'http://*/*'] })
  })

  it('does not remove permissions from a stale page snapshot', () => {
    expect(() => removeBroadSiteAccess(snapshot, null)).toThrow(/active page changed/)
    expect(browser.permissions.remove).not.toHaveBeenCalled()
  })
})

describe('active page binding', () => {
  it('rejects a switch to another tab even if it has the same URL', async () => {
    browser.tabs.query.mockResolvedValue([{ ...tab, id: 8 }])
    await expect(assertActivePage({ tabId: tab.id, tabUrl: tab.url })).rejects.toThrow(/active page changed/)
  })

  it('rejects a redirect in the same tab', async () => {
    browser.tabs.query.mockResolvedValue([{ ...tab, url: 'https://company.test/redirected' }])
    await expect(assertActivePage({ tabId: tab.id, tabUrl: tab.url })).rejects.toThrow(/active page changed/)
  })
})
