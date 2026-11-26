import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  ObjectiveSourceToolReceipts,
  objectiveSourceToolReceiptsUrl,
  loadObjectiveSourceToolReceipts,
  parseObjectiveSourceToolReceiptResponse,
  type ObjectiveSourceToolReceiptRequest,
} from './ObjectiveSourceToolReceipts'

const sourceKey = `src_${'A'.repeat(43)}`
const receiptKey = `rcp_${'B'.repeat(43)}`
const request: ObjectiveSourceToolReceiptRequest = {
  sessionId: 'session-1', finalItemId: 'final-1', sourceKey, graphRevision: 8, role: 'scout', lang: 'en',
}
const evidence = {
  schemaVersion: 'agent-harness.v2.objective-tool-receipt-evidence.v1', graphRevision: 8, sourceKey, role: 'scout',
  receipts: [{ ordinal: 1, receiptKey, toolName: 'jobs.discover', delivery: 'fresh' }],
}

function body(overrides: Record<string, unknown> = {}) {
  return { toolReceiptEvidence: { ...evidence, ...overrides } }
}
function response(value: unknown, ok = true) { return { ok, json: async () => value } as unknown as Response }

describe('ObjectiveSourceToolReceipts', () => {
  it('waits for an explicit selected-source action and keeps opaque keys out of the card', () => {
    const html = renderToStaticMarkup(<ObjectiveSourceToolReceipts {...request} />)
    expect(html).toContain('View tool receipts')
    expect(html).not.toContain(receiptKey)
    expect(html).not.toContain('Job discovery')
  })

  it('accepts only the exact wrapper and current source scope', () => {
    expect(parseObjectiveSourceToolReceiptResponse(body(), request)).toEqual(evidence)
    expect(parseObjectiveSourceToolReceiptResponse({ ...body(), private: 'hidden' }, request)).toBeNull()
    expect(parseObjectiveSourceToolReceiptResponse(body({ graphRevision: 7 }), request)).toBeNull()
    expect(parseObjectiveSourceToolReceiptResponse(body({ sourceKey: `src_${'C'.repeat(43)}` }), request)).toBeNull()
    expect(parseObjectiveSourceToolReceiptResponse(body({ role: 'analyst' }), request)).toBeNull()
    expect(parseObjectiveSourceToolReceiptResponse(body({ receipts: [{ ...evidence.receipts[0], receiptKey: 'private' }] }), request)).toBeNull()
  })

  it('uses the fixed no-store route and drops unavailable or aborted responses', async () => {
    expect(objectiveSourceToolReceiptsUrl('session/a', 'item b', sourceKey, 8)).toBe(
      `/api/agent/sessions/session%2Fa/final-items/item%20b/task-graph-sources/${sourceKey}/tool-receipts?graphRevision=8`)
    let captured: RequestInit | undefined
    const fetcher: typeof fetch = async (_url, init) => { captured = init; return response(body()) }
    await expect(loadObjectiveSourceToolReceipts(request, new AbortController().signal, fetcher)).resolves.toEqual(evidence)
    expect(captured).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
    await expect(loadObjectiveSourceToolReceipts(request, new AbortController().signal, async () => response({}, false))).resolves.toBeNull()
    const controller = new AbortController()
    controller.abort()
    await expect(loadObjectiveSourceToolReceipts(request, controller.signal, fetcher)).resolves.toBeNull()
  })

  it('localizes the explicit control without rendering receipt material', () => {
    const html = renderToStaticMarkup(<ObjectiveSourceToolReceipts {...request} lang="zh" />)
    expect(html).toContain('查看工具回执')
    expect(html).not.toContain(receiptKey)
  })
})
