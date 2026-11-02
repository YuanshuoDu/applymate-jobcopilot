import { previewMessage, sampleJob, sampleSettings } from './fixtures'

type Listener = (...args: unknown[]) => void
function event() {
  const listeners = new Set<Listener>()
  return { addListener: (listener: Listener) => listeners.add(listener), removeListener: (listener: Listener) => listeners.delete(listener) }
}

function memoryStorage(initial: Record<string, unknown>) {
  const data = { ...initial }
  return {
    async get(keys: string | string[] | null) {
      if (keys === null) return structuredClone(data)
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])]))
    },
    async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)) },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key] },
  }
}

export function createPreviewPlatform() {
  const tab = { id: 1, windowId: 1, url: sampleJob.url, active: true }
  return {
    storage: { sync: memoryStorage({ settings: sampleSettings }), local: memoryStorage({}), onChanged: event() },
    runtime: {
      onMessage: event(), lastError: undefined,
      getURL: () => '#preview-only',
      async sendMessage(message: { type?: string }, callback?: (value: unknown) => void) {
        const result = previewMessage(message.type ?? '')
        callback?.(result)
        return result
      },
    },
    tabs: {
      onActivated: event(), onUpdated: event(),
      async query(_query: unknown, callback?: (tabs: typeof tab[]) => void) { callback?.([tab]); return [tab] },
      async get() { return tab },
      async sendMessage(_id: number, message: { type?: string }) { return previewMessage(message.type ?? '') },
      async create() { throw new Error('Component preview: external navigation is disabled.') },
    },
    windows: { WINDOW_ID_CURRENT: 1 },
    sidePanel: { async open() { throw new Error('Component preview: select Side panel above.') } },
    permissions: {
      onAdded: event(), onRemoved: event(),
      async contains() { return false }, async request() { return false }, async remove() { return false },
      async getAll() { return { origins: [], permissions: [] } },
    },
    webNavigation: { async getAllFrames() { return [{ frameId: 0, parentFrameId: -1, url: sampleJob.url }] } },
    scripting: { async executeScript(): Promise<never> { throw new Error('Component preview: real website access requires the installed extension.') } },
  }
}

export function installPreviewPlatform() {
  Object.defineProperty(window, 'chrome', { configurable: true, value: createPreviewPlatform() })
  // Defense in depth: production API imports are replaced by api.ts at build time,
  // and the generated document also enforces CSP connect-src 'none'.
  window.fetch = async () => { throw new Error('Network is disabled in the component preview.') }
}
