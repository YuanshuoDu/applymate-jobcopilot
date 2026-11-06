export interface AccessFrame {
  frameId: number
  parentFrameId: number
  url: string
  documentId?: string
  origin: string | null
  granted: boolean
}

export interface SiteAccessSnapshot {
  tabId: number
  tabUrl: string
  frames: AccessFrame[]
  frameInspection: boolean
  warning?: string
  broadOrigins: string[]
}

const BROAD_ORIGINS = new Set(['http://*/*', 'https://*/*', '*://*/*', '<all_urls>'])

/** A concrete scheme/host/port, never a wildcard host or credential-bearing URL. */
export function siteOriginPattern(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*')) return null
    // Chrome treats an omitted port as any port, even when URL.origin omits
    // the scheme's default port. Keep the grant to the actual origin.
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return `${url.protocol}//${url.hostname}:${port}/*`
  } catch { return null }
}

export async function loadSiteAccess(tab: Pick<chrome.tabs.Tab, 'id' | 'url'>): Promise<SiteAccessSnapshot> {
  if (tab.id === undefined || !tab.url || !siteOriginPattern(tab.url)) throw new Error('Open a company application page first. Chrome system and local-file pages cannot be scanned.')
  const [frameInspection, permissions] = await Promise.all([
    chrome.permissions.contains({ permissions: ['webNavigation'] }),
    chrome.permissions.getAll(),
  ])
  let frames: Array<Pick<AccessFrame, 'frameId' | 'parentFrameId' | 'url' | 'documentId'>> = [
    { frameId: 0, parentFrameId: -1, url: tab.url },
  ]
  let warning: string | undefined
  if (frameInspection) {
    try {
      const discovered = await chrome.webNavigation.getAllFrames({ tabId: tab.id })
      const active = (discovered ?? []).filter(frame => !frame.errorOccurred && (!frame.documentLifecycle || frame.documentLifecycle === 'active'))
      const main = active.find(frame => frame.frameId === 0)
      if (!main || main.url !== tab.url) throw new Error('The page changed while checking embedded frames. Refresh site access and scan again.')
      frames = active.map(frame => ({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: frame.url, documentId: frame.documentId }))
    } catch (error) {
      warning = error instanceof Error ? error.message : 'Embedded frames could not be inspected. Only the main page will be scanned.'
    }
  }
  const origins = [...new Set(frames.map(frame => siteOriginPattern(frame.url)).filter((origin): origin is string => !!origin))]
  const grants = new Map(await Promise.all(origins.map(async origin => [origin, await chrome.permissions.contains({ origins: [origin] })] as const)))
  return {
    tabId: tab.id, tabUrl: tab.url, frameInspection, warning,
    frames: frames.map(frame => {
      const origin = siteOriginPattern(frame.url)
      return { ...frame, origin, granted: !!origin && grants.get(origin) === true }
    }),
    broadOrigins: (permissions.origins ?? []).filter(origin => BROAD_ORIGINS.has(origin)),
  }
}

function assertCurrent(snapshot: SiteAccessSnapshot, current: SiteAccessSnapshot | null) {
  if (snapshot !== current) throw new Error('The active page changed. Refresh site access before granting permission.')
}

/** Call directly from a click handler: no asynchronous work may precede request(). */
export function requestSiteAccess(snapshot: SiteAccessSnapshot, origin: string, current: SiteAccessSnapshot | null): Promise<boolean> {
  assertCurrent(snapshot, current)
  if (siteOriginPattern(origin) !== origin || !snapshot.frames.some(frame => frame.origin === origin)) {
    throw new Error('Only a specific site shown for the current page can be granted access.')
  }
  return chrome.permissions.request({ origins: [origin] })
}

/** Separate opt-in for discovering actual nested/redirected frame URLs. */
export function requestFrameInspection(snapshot: SiteAccessSnapshot, current: SiteAccessSnapshot | null): Promise<boolean> {
  assertCurrent(snapshot, current)
  return chrome.permissions.request({ permissions: ['webNavigation'] })
}

export function removeBroadSiteAccess(snapshot: SiteAccessSnapshot, current: SiteAccessSnapshot | null): Promise<boolean> {
  assertCurrent(snapshot, current)
  if (snapshot.broadOrigins.length === 0) return Promise.resolve(true)
  return chrome.permissions.remove({ origins: snapshot.broadOrigins })
}

export async function assertActivePage(context: { tabId: number; tabUrl: string }): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id !== context.tabId || tab.url !== context.tabUrl) throw new Error('The active page changed. Scan this page again before continuing.')
}
