import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { DraftArtifactRef } from './draft-artifact-projection'

vi.mock('./SelectedJobDraftArtifact', () => ({
  SelectedJobDraftArtifact: ({ sessionId, artifactRef }: { sessionId: string; artifactRef: DraftArtifactRef }) =>
    React.createElement('div', { 'data-mocked-draft-viewer': `${sessionId}:${artifactRef.version}` }),
}))

import {
  buildObjectiveSlotArtifactUrl,
  OBJECTIVE_SLOT_ARTIFACT_SCHEMA,
  ObjectiveSlotArtifact,
  parseObjectiveSlotArtifactResponse,
} from './ObjectiveSlotArtifact'

const expected = { graphRevision: 8, slotOrdinal: 1 }
const ref = { artifactId: 'cover-letter-1', version: 2, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}` }
const response = { artifactEvidence: { schemaVersion: OBJECTIVE_SLOT_ARTIFACT_SCHEMA, graphRevision: 8, slotOrdinal: 1, artifactRef: ref } }

describe('ObjectiveSlotArtifact', () => {
  it('builds the fixed owner-scoped lazy route', () => {
    expect(buildObjectiveSlotArtifactUrl('session/one', 'final item', 8, 1)).toBe(
      '/api/agent/sessions/session%2Fone/final-items/final%20item/objective-report/slots/1/artifact?graphRevision=8')
  })

  it('accepts only the closed matching envelope and immutable artifact reference', () => {
    expect(parseObjectiveSlotArtifactResponse(response, expected)).toEqual(ref)
    expect(parseObjectiveSlotArtifactResponse({ ...response, extra: 'hidden' }, expected)).toBeNull()
    expect(parseObjectiveSlotArtifactResponse({ ...response, artifactEvidence: { ...response.artifactEvidence, graphRevision: 7 } }, expected)).toBeNull()
    expect(parseObjectiveSlotArtifactResponse({ ...response, artifactEvidence: { ...response.artifactEvidence, slotOrdinal: 2 } }, expected)).toBeNull()
    expect(parseObjectiveSlotArtifactResponse({ ...response, artifactEvidence: { ...response.artifactEvidence, artifactRef: { ...ref, contentHash: 'sha256:short' } } }, expected)).toBeNull()
    expect(parseObjectiveSlotArtifactResponse({ ...response, artifactEvidence: { ...response.artifactEvidence, artifactRef: { ...ref, privateTaskId: 'task-1' } } }, expected)).toBeNull()
  })

  it('does not fetch or mount the viewer before an explicit ready-slot action', () => {
    const ready = renderToStaticMarkup(<ObjectiveSlotArtifact sessionId="session-1" finalItemId="final-1" graphRevision={8}
      slotOrdinal={1} ready ownedLabel="Example Company — Engineer" lang="en" />)
    expect(ready).toContain('View verified draft')
    expect(ready).not.toContain('data-mocked-draft-viewer')
    expect(ready).not.toContain('Request application review')
    expect(renderToStaticMarkup(<ObjectiveSlotArtifact sessionId="session-1" finalItemId="final-1" graphRevision={8}
      slotOrdinal={1} ready={false} ownedLabel="Example Company — Engineer" lang="en" />)).toBe('')
    expect(renderToStaticMarkup(<ObjectiveSlotArtifact sessionId="session-1" finalItemId="final-1" graphRevision={8}
      slotOrdinal={1} ready ownedLabel={null} lang="en" />)).toBe('')
  })

  it('localizes the explicit action and does not expose the reference envelope', () => {
    const html = renderToStaticMarkup(<ObjectiveSlotArtifact sessionId="session-1" finalItemId="final-1" graphRevision={8}
      slotOrdinal={1} ready ownedLabel="示例公司 — 工程师" lang="zh" />)
    expect(html).toContain('查看已验证草稿')
    expect(html).toContain('示例公司 — 工程师')
    expect(html).not.toContain(ref.artifactId)
    expect(html).not.toContain(ref.contentHash)
  })
})
