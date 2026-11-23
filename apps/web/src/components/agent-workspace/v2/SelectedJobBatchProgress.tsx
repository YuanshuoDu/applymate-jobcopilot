'use client'

import React, { useEffect, useId, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import type { SelectedJobBatchWorkbenchModel } from '@/lib/agent/session/selected-job-batch-workbench-read-model'

import { SelectedJobDraftArtifact } from './SelectedJobDraftArtifact'
import { validArtifactRef } from './draft-artifact-projection'

type BranchStatus = SelectedJobBatchWorkbenchModel['status']
type OpenDraft = Readonly<{ scope: string; target: string }> | null

export function SelectedJobBatchProgress({ model }: { readonly model: SelectedJobBatchWorkbenchModel }) {
  const { lang } = useI18n()
  const id = useId()
  const scope = JSON.stringify([model.sessionId, model.turnId, model.source, model.graph,
    model.jobs.map(job => [job.slotId, job.jobId, refKey(job.writer.artifactRef)])])
  const [open, setOpen] = useState<OpenDraft>(null)
  useEffect(() => { setOpen(current => current?.scope === scope ? current : null) }, [scope])
  const expanded = open?.scope === scope ? open.target : null
  const copy = lang === 'zh'
    ? { title: '所选职位进度', batch: '批次准备状态', draftOnly: '仅准备草稿，不会提交申请。', job: '职位', writer: '写作', reviewer: '审核', open: '查看草稿', close: '关闭草稿', unavailable: '已完成；草稿暂不可读取', pending: '进行中', partial: '部分完成', completed: '已完成', failed: '失败', passed: '通过', needs_revision: '需要修改', rejected: '已拒绝', stale: '已过期' }
    : { title: 'Selected jobs progress', batch: 'Batch preparation', draftOnly: 'Draft preparation only. No application is submitted.', job: 'Job', writer: 'Writing', reviewer: 'Review', open: 'View saved draft', close: 'Close draft', unavailable: 'Completed; saved draft unavailable', pending: 'In progress', partial: 'Partial', completed: 'Completed', failed: 'Failed', passed: 'Passed', needs_revision: 'Needs revision', rejected: 'Rejected', stale: 'Stale' }
  const label = (status: BranchStatus) => copy[status]

  return <section aria-label={copy.title} style={sectionStyle}>
    <h2 style={headingStyle}>{copy.title}</h2>
    <p role="status" style={hintStyle}>{copy.batch}: {label(model.status)}</p>
    <p style={hintStyle}>{copy.draftOnly}</p>
    <ol style={listStyle}>
      {model.jobs.map((job, index) => {
        const ref = job.writer.status === 'completed' && validArtifactRef(job.writer.artifactRef) ? job.writer.artifactRef : null
        const target = JSON.stringify([job.slotId, job.jobId, ref ? refKey(ref) : null])
        const isOpen = Boolean(ref && expanded === target)
        const regionId = `${id}-draft-${index}`
        const writerStatus = job.writer.status === 'completed' && !ref ? copy.unavailable : label(job.writer.status)
        const reviewStatus = `${label(job.reviewer.status)}${job.reviewer.reviewStatus ? ` · ${copy[job.reviewer.reviewStatus]}` : ''}`
        return <li key={`${job.slotId}:${job.jobId}`} style={jobStyle}>
          <h3 style={jobHeadingStyle}>{job.company} · {job.role}</h3>
          <p style={hintStyle}>{copy.job}: {label(job.status)}</p>
          <p style={hintStyle}>{copy.writer}: {writerStatus}</p>
          <p style={hintStyle}>{copy.reviewer}: {reviewStatus}</p>
          {ref && <>
            <button type="button" aria-expanded={isOpen} aria-controls={regionId}
              onClick={() => setOpen(isOpen ? null : { scope, target })}>
              {isOpen ? copy.close : `${copy.open}: ${job.role} · ${job.company}`}
            </button>
            <div id={regionId} hidden={!isOpen} aria-label={`${copy.open}: ${job.role}`}>
              {isOpen && <SelectedJobDraftArtifact sessionId={model.sessionId} artifactRef={ref} />}
            </div>
          </>}
        </li>
      })}
    </ol>
  </section>
}

function refKey(ref: unknown): string {
  if (!validArtifactRef(ref)) return 'none'
  return JSON.stringify([ref.artifactId, ref.version, ref.contentHash, ref.sourceDigest])
}

const sectionStyle: React.CSSProperties = { display: 'grid', gap: 8, color: 'var(--text)' }
const headingStyle: React.CSSProperties = { margin: 0, fontSize: 15 }
const listStyle: React.CSSProperties = { display: 'grid', gap: 10, margin: 0, paddingLeft: 24 }
const jobStyle: React.CSSProperties = { display: 'grid', gap: 4, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }
const jobHeadingStyle: React.CSSProperties = { margin: 0, fontSize: 13 }
const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 12 }
