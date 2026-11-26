import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { buildObjectiveSlotReviewerReceiptUrl, loadObjectiveSlotReviewerReceipt, ObjectiveSlotReviewerReceipt } from './ObjectiveSlotReviewerReceipt'

const receipt = { schemaVersion: 'agent-harness.v2.objective-slot-reviewer-receipt.v1', graphRevision: 8,
  slotOrdinal: 1, artifactVersion: 3, outcome: 'passed', receiptKey: `review-${'a'.repeat(64)}` } as const
const response = { reviewerReceipt: receipt }

describe('ObjectiveSlotReviewerReceipt', () => {
  it('builds the immutable receipt route beneath the artifact route', () => {
    expect(buildObjectiveSlotReviewerReceiptUrl('session/one', 'final item', 8, 1)).toBe(
      '/api/agent/sessions/session%2Fone/final-items/final%20item/objective-report/slots/1/artifact/reviewer-receipt?graphRevision=8')
  })

  it('loads only the closed receipt projection and rejects a mismatched scope', async () => {
    const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain('/artifact/reviewer-receipt?graphRevision=8')
      expect(init?.cache).toBe('no-store')
      return new Response(JSON.stringify(response), { status: 200 })
    }
    await expect(loadObjectiveSlotReviewerReceipt({ sessionId: 'session-1', finalItemId: 'final-1', graphRevision: 8, slotOrdinal: 1 }, new AbortController().signal, fetcher)).resolves.toEqual(receipt)
    await expect(loadObjectiveSlotReviewerReceipt({ sessionId: 'session-1', finalItemId: 'final-1', graphRevision: 7, slotOrdinal: 1 }, new AbortController().signal, fetcher)).resolves.toBeNull()
  })

  it('forwards the abort signal and rejects unavailable or unsafe bodies', async () => {
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const unsafeFetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined
      return new Response(JSON.stringify({ reviewerReceipt: { ...receipt, privateOutput: 'RAW' } }), { status: 200 })
    }
    await expect(loadObjectiveSlotReviewerReceipt({ sessionId: 'session-1', finalItemId: 'final-1', graphRevision: 8, slotOrdinal: 1 }, controller.signal, unsafeFetcher)).resolves.toBeNull()
    expect(seenSignal).toBe(controller.signal)
    const unavailableFetcher = async () => new Response('unavailable', { status: 404 })
    await expect(loadObjectiveSlotReviewerReceipt({ sessionId: 'session-1', finalItemId: 'final-1', graphRevision: 8, slotOrdinal: 1 }, controller.signal, unavailableFetcher)).resolves.toBeNull()
  })

  it('offers an explicit receipt action without loading or exposing receipt data', () => {
    const html = renderToStaticMarkup(<ObjectiveSlotReviewerReceipt sessionId="session-1" finalItemId="final-1"
      graphRevision={8} slotOrdinal={1} ready ownedLabel="Example Company — Engineer" lang="en" />)
    expect(html).toContain('View Reviewer receipt')
    expect(html).not.toContain('review-')
    expect(html).not.toContain('Application review')
    expect(html).not.toContain('submit')
  })

  it('localizes the action and hides it for non-ready or unowned slots', () => {
    expect(renderToStaticMarkup(<ObjectiveSlotReviewerReceipt sessionId="session-1" finalItemId="final-1"
      graphRevision={8} slotOrdinal={1} ready ownedLabel="示例公司 — 工程师" lang="zh" />)).toContain('查看本次审核回执')
    expect(renderToStaticMarkup(<ObjectiveSlotReviewerReceipt sessionId="session-1" finalItemId="final-1"
      graphRevision={8} slotOrdinal={1} ready={false} ownedLabel="Example" lang="en" />)).toBe('')
    expect(renderToStaticMarkup(<ObjectiveSlotReviewerReceipt sessionId="session-1" finalItemId="final-1"
      graphRevision={8} slotOrdinal={1} ready ownedLabel={null} lang="en" />)).toBe('')
  })
})
