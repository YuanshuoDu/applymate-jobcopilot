import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const language = { value: 'en' as 'en' | 'zh' }

vi.mock('@/lib/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ lang: language.value, t: (key: string) => key }),
}))
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }))

import {
  SelectedWorkerDraftArtifact,
  selectedWorkerDraftDisclosureContent,
  selectedWorkerDraftDisclosureKey,
  selectedWorkerDraftForSelection,
} from './SelectedWorkerDraftArtifact'
import type { ChildWorkerTask } from './ChildWorkerAttachView'
import type { TaskTreeNode } from './types'

const artifactRef = {
  artifactId: 'draft-1', version: 3,
  contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}`,
}
const root: ChildWorkerTask = {
  id: 'root-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  role: 'orchestrator', taskType: 'root', status: 'completed', goal: 'Create a draft', hasResult: false,
}
const parent: ChildWorkerTask = {
  id: 'parent-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', parentTaskId: 'root-1',
  role: 'analyst', taskType: 'analysis', status: 'completed', goal: 'Gather evidence', hasResult: true,
}
const writer: ChildWorkerTask = {
  id: 'writer-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', parentTaskId: 'parent-1',
  role: 'writer', taskType: 'cover_letter_draft', status: 'completed', goal: 'Draft a cover letter', hasResult: true, artifactRef,
}
const node: TaskTreeNode = { id: 'task:writer-1', kind: 'task', label: 'Cover letter', status: 'completed' }
const lineage = [root, parent, writer]

describe('SelectedWorkerDraftArtifact', () => {
  beforeEach(() => { language.value = 'en' })

  it('offers the saved draft only for the exact completed Writer task with bound child lineage', () => {
    expect(selectedWorkerDraftForSelection('session-1', node, writer, lineage)?.artifactRef).toEqual(artifactRef)
    expect(selectedWorkerDraftForSelection('session-1', { ...node, id: 'task:other' }, writer, lineage)).toBeNull()
    expect(selectedWorkerDraftForSelection('other-session', node, writer, lineage)).toBeNull()
    expect(selectedWorkerDraftForSelection('session-1', node, { ...writer, status: 'running' }, lineage)).toBeNull()
    expect(selectedWorkerDraftForSelection('session-1', node, { ...writer, hasResult: false }, lineage)).toBeNull()
    expect(selectedWorkerDraftForSelection('session-1', node, { ...writer, role: 'analyst' }, lineage)).toBeNull()
    expect(selectedWorkerDraftForSelection('session-1', node, { ...writer, parentTaskId: undefined }, lineage)).toBeNull()
    expect(selectedWorkerDraftForSelection('session-1', node, { ...writer, parentTaskId: 'writer-1' }, lineage)).toBeNull()
    expect(selectedWorkerDraftForSelection('session-1', node, { ...writer, artifactRef: { ...artifactRef, version: 0 } }, lineage)).toBeNull()
  })

  it('accepts a valid historical Writer when its parent row is outside the loaded task page', () => {
    expect(selectedWorkerDraftForSelection('session-1', node, writer, [writer])?.task.id).toBe('writer-1')
  })

  it('keeps the disclosure closed on selection and mounts the exact-version reader only when opened', () => {
    const closed = renderToStaticMarkup(<SelectedWorkerDraftArtifact sessionId="session-1" artifactRef={artifactRef} />)
    expect(closed).toContain('Open saved draft')
    expect(closed).not.toContain('data-selected-job-draft')
    expect(selectedWorkerDraftDisclosureContent(false, 'session-1', artifactRef)).toBeNull()

    const opened = renderToStaticMarkup(<>{selectedWorkerDraftDisclosureContent(true, 'session-1', artifactRef)}</>)
    expect(opened).toContain('data-selected-job-draft="true"')
    expect(opened).toContain('data-draft-version="3"')
  })

  it('localizes the disclosure and changes its React scope when task, session, or artifact version changes', () => {
    language.value = 'zh'
    expect(renderToStaticMarkup(<SelectedWorkerDraftArtifact sessionId="session-1" artifactRef={artifactRef} />)).toContain('打开已保存草稿')

    const selection = selectedWorkerDraftForSelection('session-1', node, writer, lineage)!
    const key = selectedWorkerDraftDisclosureKey('session-1', selection)
    expect(selectedWorkerDraftDisclosureKey('session-2', selection)).not.toBe(key)
    expect(selectedWorkerDraftDisclosureKey('session-1', selectedWorkerDraftForSelection(
      'session-1', { ...node, id: 'task:writer-2' }, { ...writer, id: 'writer-2' },
      [...lineage, { ...writer, id: 'writer-2' }],
    )!)).not.toBe(key)
    expect(selectedWorkerDraftDisclosureKey('session-1', {
      ...selection, artifactRef: { ...selection.artifactRef, version: 4 },
    })).not.toBe(key)
  })
})
