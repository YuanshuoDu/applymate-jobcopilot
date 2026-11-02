import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { messageScannedDocument, scanAccessibleFrames, type FormScanContext } from './frame-access'
import type { AccessFrame, SiteAccessSnapshot } from './site-access'
import type { FormFieldSchema } from './types'

type Injection = {
  target: { tabId: number; frameIds?: number[]; documentIds?: string[]; allFrames?: boolean }
  files?: string[]
  args?: unknown[]
}
const tab = { id: 7, url: 'https://company.test/apply' }
const field: FormFieldSchema = { id: 'name-field', type: 'text', label: 'First name', required: true, surroundingText: '' }
const main: AccessFrame = { frameId: 0, parentFrameId: -1, documentId: 'main-document', url: tab.url, origin: 'https://company.test:443/*', granted: true }
const embedded: AccessFrame = { frameId: 13, parentFrameId: 0, documentId: 'ats-document', url: 'https://ats.test/redirected/application', origin: 'https://ats.test:443/*', granted: true }
const nested: AccessFrame = { frameId: 21, parentFrameId: 13, documentId: 'nested-document', url: 'https://forms.test/form/2', origin: 'https://forms.test:443/*', granted: true }

function makeSnapshot(frames: AccessFrame[] = [main, embedded, nested]): SiteAccessSnapshot {
  return { tabId: tab.id, tabUrl: tab.url, frames, frameInspection: true, broadOrigins: [] }
}

function chromeMock(snapshot: SiteAccessSnapshot) {
  return {
    tabs: {
      query: vi.fn(async () => [tab]),
      sendMessage: vi.fn(async (_tabId: number, message: { type: string }, _options: { documentId: string }): Promise<unknown> => message.type === 'SCAN_FORM' ? { type: 'FORM_DETECTED', fields: [] } : { ok: true }),
    },
    scripting: {
      executeScript: vi.fn(async (spec: Injection): Promise<Array<{ frameId: number; documentId?: string; result?: unknown }>> => {
        const frame = snapshot.frames.find(item => spec.target.documentIds?.includes(item.documentId ?? '') || spec.target.frameIds?.includes(item.frameId))
        if (!frame) throw new Error('No such document')
        return [{ frameId: frame.frameId, documentId: frame.documentId ?? 'newly-pinned-main', result: spec.files ? undefined : spec.args ? [field] : { url: frame.url, ready: frame.frameId !== 21 } }]
      }),
    },
  }
}

let snapshot: SiteAccessSnapshot
let browser: ReturnType<typeof chromeMock>
beforeEach(() => {
  snapshot = makeSnapshot()
  browser = chromeMock(snapshot)
  vi.stubGlobal('chrome', browser)
})
afterEach(() => vi.unstubAllGlobals())

describe('individually authorized documents', () => {
  it('scans real nested documents and routes duplicate local IDs independently', async () => {
    const result = await scanAccessibleFrames(snapshot)
    expect(result.fields.map(item => item.id)).toEqual(['frame|0|name-field', 'frame|13|name-field', 'frame|21|name-field'])
    expect(result.context.documents).toEqual([main, embedded, nested].map(item => ({ frameId: item.frameId, documentId: item.documentId, url: item.url })))
    const scans = browser.scripting.executeScript.mock.calls.filter(([spec]) => spec.args)
    expect(scans).toHaveLength(3)
    expect(scans.map(([spec]) => spec.target)).toEqual(expect.arrayContaining([
      { tabId: 7, documentIds: ['main-document'] },
      { tabId: 7, documentIds: ['ats-document'] },
      { tabId: 7, documentIds: ['nested-document'] },
    ]))
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, documentIds: ['nested-document'] }, files: ['content.js'] }))
    expect(browser.scripting.executeScript.mock.calls.every(([spec]) => !spec.target.allFrames)).toBe(true)
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('pins the main document even when optional frame discovery was not granted', async () => {
    snapshot = makeSnapshot([{ ...main, documentId: undefined }])
    snapshot.frameInspection = false
    browser = chromeMock(snapshot)
    // The first probe supplies the Chrome documentId, then future injections use it.
    const firstProbe = browser.scripting.executeScript.getMockImplementation()!
    browser.scripting.executeScript.mockImplementation(async spec => spec.target.documentIds?.[0] === 'newly-pinned-main'
      ? [{ frameId: 0, documentId: 'newly-pinned-main', result: [field] }]
      : firstProbe(spec))
    vi.stubGlobal('chrome', browser)
    const result = await scanAccessibleFrames(snapshot)
    expect(browser.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 7, frameIds: [0] })
    expect(browser.scripting.executeScript.mock.calls[1][0].target).toEqual({ tabId: 7, documentIds: ['newly-pinned-main'] })
    expect(result.context.documents[0].documentId).toBe('newly-pinned-main')
  })

  it('never probes denied ad frames or unsupported opaque URLs, and reports partial access', async () => {
    snapshot.frames.push(
      { frameId: 30, parentFrameId: 0, url: 'https://ads.test/render', documentId: 'ad-document', origin: 'https://ads.test:443/*', granted: false },
      { frameId: 31, parentFrameId: 13, url: 'about:srcdoc', documentId: 'blank-document', origin: null, granted: false },
    )
    const result = await scanAccessibleFrames(snapshot)
    expect(result.skippedFrames).toBe(2)
    expect(result.failedFrames).toBe(0)
    expect(browser.scripting.executeScript.mock.calls.some(([spec]) => spec.target.documentIds?.includes('ad-document') || spec.target.documentIds?.includes('blank-document'))).toBe(false)
  })

  it('can scan a selected ATS frame without requiring access to the embedding employer page', async () => {
    snapshot.frames[0] = { ...main, granted: false }
    const result = await scanAccessibleFrames(snapshot)
    expect(result.skippedFrames).toBe(1)
    expect(result.fields.map(item => item.frameId)).toEqual([13, 21])
    expect(browser.scripting.executeScript.mock.calls.some(([spec]) => spec.target.documentIds?.includes('main-document'))).toBe(false)
  })

  it('retains other results when a selected iframe denies injection', async () => {
    const execute = browser.scripting.executeScript.getMockImplementation()!
    browser.scripting.executeScript.mockImplementation(async spec => {
      if (spec.target.documentIds?.includes('ats-document')) throw new Error('Cannot access contents of this page')
      return execute(spec)
    })
    const result = await scanAccessibleFrames(snapshot)
    expect(result.failedFrames).toBe(1)
    expect(result.fields.map(item => item.frameId)).toEqual([0, 21])
    expect(result.context.documents.map(item => item.frameId)).toEqual([0, 21])
  })

  it('uses a current-document-only fallback, excluding old unbound recursive frame IDs', async () => {
    snapshot = makeSnapshot([main])
    browser = chromeMock(snapshot)
    const execute = browser.scripting.executeScript.getMockImplementation()!
    browser.scripting.executeScript.mockImplementation(async spec => spec.args
      ? [{ frameId: 0, documentId: 'main-document', result: [] }]
      : execute(spec))
    browser.tabs.sendMessage.mockImplementation(async (_id, message) => message.type === 'SCAN_FORM'
      ? { type: 'FORM_DETECTED', fields: [field, { ...field, id: 'iframe|unbound-url|other' }] }
      : { ok: true })
    vi.stubGlobal('chrome', browser)
    const result = await scanAccessibleFrames(snapshot)
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'SCAN_FORM', frameOnly: true }, { documentId: 'main-document' })
    expect(result.fields).toHaveLength(1)
    expect(result.fields[0].id).toBe('frame|0|name-field')
  })
})

describe('frame navigation and active-tab races', () => {
  it.each([
    { documentId: 'ats-document', result: { url: 'https://new-origin.test/login', ready: false } },
    { documentId: 'replacement-document', result: { url: embedded.url, ready: false } },
  ])('does not inject or scan a redirected/replaced document: %j', changed => {
    const execute = browser.scripting.executeScript.getMockImplementation()!
    browser.scripting.executeScript.mockImplementation(async spec => spec.target.documentIds?.includes('ats-document')
      ? [{ frameId: 13, ...changed }]
      : execute(spec))
    return scanAccessibleFrames(snapshot).then(result => {
      expect(result.failedFrames).toBe(1)
      expect(result.fields.some(item => item.frameId === 13)).toBe(false)
      expect(browser.scripting.executeScript.mock.calls.filter(([spec]) => spec.target.documentIds?.includes('ats-document'))).toHaveLength(1)
    })
  })

  it('rejects mismatched document IDs on scan results instead of attaching them to the old frame', async () => {
    const execute = browser.scripting.executeScript.getMockImplementation()!
    browser.scripting.executeScript.mockImplementation(async spec => spec.args && spec.target.documentIds?.includes('ats-document')
      ? [{ frameId: 13, documentId: 'replacement-document', result: [field] }]
      : execute(spec))
    expect((await scanAccessibleFrames(snapshot)).context.documents.map(item => item.frameId)).toEqual([0, 21])
  })

  it('performs no injection when the active tab changed before scanning', async () => {
    browser.tabs.query.mockResolvedValue([{ id: 8, url: tab.url }])
    await expect(scanAccessibleFrames(snapshot)).rejects.toThrow(/active page changed/)
    expect(browser.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('discards collected fields if the active tab changes while scans are running', async () => {
    browser.tabs.query.mockResolvedValueOnce([tab]).mockResolvedValue([{ id: 8, url: tab.url }])
    await expect(scanAccessibleFrames(snapshot)).rejects.toThrow(/active page changed/)
  })
})

describe('reviewed-answer document binding', () => {
  const context: FormScanContext = { tabId: 7, tabUrl: tab.url, documents: [{ frameId: 13, documentId: 'ats-document', url: embedded.url }] }
  const message = { type: 'APPLY_FIELD_VALUES', fields: [{ fieldId: 'frame|13|name-field', value: 'Candidate' }] }

  beforeEach(() => {
    browser.scripting.executeScript.mockResolvedValue([{ frameId: 13, documentId: 'ats-document', result: embedded.url }])
    browser.tabs.sendMessage.mockResolvedValue({ type: 'APPLY_RESULT', failed: [] })
  })

  it.each(['APPLY_FIELD_VALUES', 'READ_FIELD_VALUES', 'OPEN_UPLOAD_PICKER'])('pins %s to the exact reviewed document', async type => {
    await messageScannedDocument(context, 13, { ...message, type }, () => true)
    expect(browser.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 7, documentIds: ['ats-document'] })
    expect(browser.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(7, { ...message, type }, { documentId: 'ats-document' })
    expect(browser.tabs.query).toHaveBeenCalledTimes(2)
  })

  it('does not route old answers to a reused frameId after a navigation', async () => {
    browser.scripting.executeScript.mockRejectedValue(new Error('No document with id ats-document'))
    await expect(messageScannedDocument(context, 13, message, () => true)).rejects.toThrow(/No document/)
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('requires rescanning after a same-document URL change', async () => {
    browser.scripting.executeScript.mockResolvedValue([{ frameId: 13, documentId: 'ats-document', result: 'https://ats.test/next-step' }])
    await expect(messageScannedDocument(context, 13, message, () => true)).rejects.toThrow(/navigated/)
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('rechecks the active tab immediately before sending reviewed data', async () => {
    browser.tabs.query.mockResolvedValueOnce([tab]).mockResolvedValue([{ id: 8, url: tab.url }])
    await expect(messageScannedDocument(context, 13, message, () => true)).rejects.toThrow(/active page changed/)
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('honors an invalidated scan between the document probe and sending data', async () => {
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    await expect(messageScannedDocument(context, 13, message, current)).rejects.toThrow(/active page changed/)
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses frames not included in the reviewed scan', async () => {
    await expect(messageScannedDocument(context, 21, message, () => true)).rejects.toThrow(/not scanned/)
    expect(browser.scripting.executeScript).not.toHaveBeenCalled()
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled()
  })
})
