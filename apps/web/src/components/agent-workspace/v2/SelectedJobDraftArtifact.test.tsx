import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }))

import { SelectedJobDraftArtifact } from './SelectedJobDraftArtifact'

describe('SelectedJobDraftArtifact', () => {
  it('does not render when no task artifact reference exists', () => {
    expect(renderToStaticMarkup(<SelectedJobDraftArtifact sessionId="session-1" artifactRef={null} />)).toBe('')
  })

  it('renders the immutable draft identity before its owner-scoped payload is available', () => {
    const html = renderToStaticMarkup(<SelectedJobDraftArtifact sessionId="session-1" artifactRef={{ artifactId: 'draft-1', version: 1, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}` }} />)
    expect(html).toContain('Cover letter draft v1')
    expect(html).not.toContain('data-draft-body')
  })

  it('fails closed on a malformed or identity-bearing artifact ref', () => {
    const html = renderToStaticMarkup(<SelectedJobDraftArtifact sessionId="session-1" artifactRef={{ artifactId: 'draft-1', version: 1, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}`, userId: 'foreign' } as never} />)
    expect(html).toBe('')
  })
})
