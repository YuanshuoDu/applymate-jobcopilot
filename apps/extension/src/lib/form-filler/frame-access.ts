import { scanDocumentFields } from './direct-scanner'
import { filterSafeFormFields, FORM_VALUE_TEXT_SELECTOR, SENSITIVE_FIELD_PATTERN } from './field-safety'
import { assertActivePage, type AccessFrame, type SiteAccessSnapshot } from './site-access'
import type { FormFieldSchema } from './types'

export interface ScannedDocument { frameId: number; documentId: string; url: string }
export interface FormScanContext { tabId: number; tabUrl: string; documents: ScannedDocument[] }
export interface FrameScanResult { fields: FormFieldSchema[]; context: FormScanContext; failedFrames: number; skippedFrames: number }

async function prepareDocument(snapshot: SiteAccessSnapshot, frame: AccessFrame): Promise<ScannedDocument> {
  const [probe] = await chrome.scripting.executeScript({
    target: frame.documentId ? { tabId: snapshot.tabId, documentIds: [frame.documentId] } : { tabId: snapshot.tabId, frameIds: [frame.frameId] },
    world: 'ISOLATED',
    func: () => ({
      url: location.href,
      ready: (globalThis as typeof globalThis & { __applyMateContentScriptState?: string }).__applyMateContentScriptState === 'ready',
    }),
  })
  if (!probe?.documentId || probe.result?.url !== frame.url || probe.frameId !== frame.frameId ||
      (frame.documentId && probe.documentId !== frame.documentId)) {
    throw new Error('An embedded page navigated. Scan again to use its current document.')
  }
  const document = { frameId: frame.frameId, documentId: probe.documentId, url: frame.url }
  if (!probe.result.ready) {
    await chrome.scripting.executeScript({ target: { tabId: snapshot.tabId, documentIds: [document.documentId] }, files: ['content.js'], world: 'ISOLATED' })
  }
  return document
}

/** Scan authorized documents separately so a denied/removed frame does not fail other frames. */
export async function scanAccessibleFrames(snapshot: SiteAccessSnapshot): Promise<FrameScanResult> {
  await assertActivePage(snapshot)
  const permitted = snapshot.frames.filter(frame => frame.granted && frame.origin)
  const results = await Promise.allSettled(permitted.map(async frame => {
    const document = await prepareDocument(snapshot, frame)
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: snapshot.tabId, documentIds: [document.documentId] },
      world: 'ISOLATED', func: scanDocumentFields, args: [SENSITIVE_FIELD_PATTERN, FORM_VALUE_TEXT_SELECTOR],
    })
    if (result?.documentId !== document.documentId) throw new Error('The frame changed while scanning.')
    let fields = result.result ?? []
    if (!fields.length) {
      const fallback = await chrome.tabs.sendMessage(snapshot.tabId, { type: 'SCAN_FORM', frameOnly: true }, { documentId: document.documentId }) as { type?: string; fields?: FormFieldSchema[] } | undefined
      // Legacy fallback can recurse into same-origin iframes without Chrome IDs.
      // Their fields need a separate explicitly discovered document to remain safe across navigation.
      fields = fallback?.type === 'FORM_DETECTED' ? (fallback.fields ?? []).filter(field => !field.id.startsWith('iframe|')) : []
    }
    return { document, fields: filterSafeFormFields(fields).map(field => ({ ...field, id: `frame|${document.frameId}|${field.id}`, frameId: document.frameId })) }
  }))
  await assertActivePage(snapshot)
  const successful = results.filter(result => result.status === 'fulfilled')
  return {
    fields: successful.flatMap(result => result.value.fields),
    context: { tabId: snapshot.tabId, tabUrl: snapshot.tabUrl, documents: successful.map(result => result.value.document) },
    failedFrames: results.length - successful.length,
    skippedFrames: snapshot.frames.length - permitted.length,
  }
}

/** Pin every fill/read/upload to the exact document that the user reviewed. */
export async function messageScannedDocument<T>(context: FormScanContext, frameId: number, message: object, isCurrent: () => boolean): Promise<T> {
  if (!isCurrent()) throw new Error('This scan is no longer current. Scan again.')
  await assertActivePage(context)
  const document = context.documents.find(item => item.frameId === frameId)
  if (!document) throw new Error('This embedded page was not scanned. Grant its site access and scan again.')
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId: context.tabId, documentIds: [document.documentId] }, world: 'ISOLATED', func: () => location.href,
  })
  if (probe?.documentId !== document.documentId || probe.result !== document.url) throw new Error('The application page navigated. Scan again before filling.')
  await assertActivePage(context)
  if (!isCurrent()) throw new Error('The active page changed. Scan again before filling.')
  return chrome.tabs.sendMessage(context.tabId, message, { documentId: document.documentId }) as Promise<T>
}
