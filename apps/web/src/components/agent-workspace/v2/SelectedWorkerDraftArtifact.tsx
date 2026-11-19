'use client'

import React, { useState } from 'react'

import { useI18n } from '@/lib/i18n'

import { SelectedJobDraftArtifact } from './SelectedJobDraftArtifact'
import { validArtifactRef, type DraftArtifactRef } from './draft-artifact-projection'
import type { SupervisorTaskSummary } from './task-tree-projection'
import type { TaskTreeNode } from './types'
import type { ChildWorkerTask } from './ChildWorkerAttachView'

export interface SelectedWorkerDraftSelection {
  readonly task: SupervisorTaskSummary
  readonly artifactRef: DraftArtifactRef
}

export function selectedWorkerDraftForSelection(
  sessionId: string,
  selectedNode: TaskTreeNode | undefined,
  selectedWorker: ChildWorkerTask | null,
  tasks: readonly ChildWorkerTask[],
): SelectedWorkerDraftSelection | null {
  if (selectedNode?.kind !== 'task' || !selectedWorker) return null
  const task = tasks.find(candidate => `task:${candidate.id}` === selectedNode.id)
  if (!task || !sameTaskSnapshot(task, selectedWorker) || task.sessionId !== sessionId
    || task.status !== 'completed' || task.hasResult !== true || task.role !== 'writer'
    || task.taskType !== 'cover_letter_draft' || !validArtifactRef(task.artifactRef)
    || !task.turnId || !task.rootTaskId || !task.parentTaskId
    || task.id === task.rootTaskId || task.parentTaskId === task.id) return null
  return { task, artifactRef: task.artifactRef }
}

export function selectedWorkerDraftDisclosureKey(sessionId: string, selection: SelectedWorkerDraftSelection): string {
  const { task, artifactRef: ref } = selection
  return JSON.stringify([sessionId, task.id, task.turnId, task.rootTaskId, task.parentTaskId,
    ref.artifactId, ref.version, ref.contentHash, ref.sourceDigest])
}

export function selectedWorkerDraftDisclosureContent(
  open: boolean,
  sessionId: string,
  artifactRef: DraftArtifactRef,
): React.ReactNode {
  return open ? <SelectedJobDraftArtifact sessionId={sessionId} artifactRef={artifactRef} /> : null
}

export function SelectedWorkerDraftArtifact({ sessionId, artifactRef }: {
  readonly sessionId: string
  readonly artifactRef: DraftArtifactRef
}) {
  const { lang } = useI18n()
  const [open, setOpen] = useState(false)
  const copy = lang === 'zh'
    ? { open: '打开已保存草稿', close: '收起已保存草稿' }
    : { open: 'Open saved draft', close: 'Close saved draft' }
  return (
    <section data-selected-worker-draft-disclosure="true" style={disclosureStyle}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} style={buttonStyle}>
        {open ? copy.close : copy.open}
      </button>
      {selectedWorkerDraftDisclosureContent(open, sessionId, artifactRef)}
    </section>
  )
}

function sameTaskSnapshot(left: SupervisorTaskSummary, right: SupervisorTaskSummary): boolean {
  const leftRef = left.artifactRef
  const rightRef = right.artifactRef
  return left.id === right.id && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.parentTaskId === right.parentTaskId
    && left.role === right.role && left.taskType === right.taskType && left.status === right.status
    && left.hasResult === right.hasResult && validArtifactRef(leftRef) && validArtifactRef(rightRef)
    && leftRef.artifactId === rightRef.artifactId && leftRef.version === rightRef.version
    && leftRef.contentHash === rightRef.contentHash && leftRef.sourceDigest === rightRef.sourceDigest
}

const disclosureStyle: React.CSSProperties = { display: 'grid', gap: 4, margin: '8px 0' }
const buttonStyle: React.CSSProperties = { justifySelf: 'start', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 9px', background: 'var(--bg)', color: 'var(--primary)', cursor: 'pointer', font: 'inherit', fontSize: 10 }
