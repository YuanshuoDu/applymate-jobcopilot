'use client'

import React, { useRef, useState } from 'react'
import { useApi } from '@/lib/hooks'
import {
  parseObjectiveJourneyReport,
  type ObjectiveJourneyRequirementEvidenceCoverage,
  type ObjectiveJourneyReportedScoreFloor,
  type ObjectiveJourneyReport as Report,
} from '@/lib/agent/session/objective-journey-report-contract'
import type { Lang } from '@/lib/i18n'
import { objectiveJourneySkillComparisonKey, ObjectiveJourneySkillComparison } from './ObjectiveJourneySkillComparison'

import { ObjectiveSlotArtifact } from './ObjectiveSlotArtifact'

type ExpectedCounts = Report['sourceCounts']
type ExpectedSlot = Readonly<{ ordinal: number; tailoringStatus: Report['slots'][number]['tailoringStatus'] }>

export function buildObjectiveJourneyReportUrl(sessionId: string, finalItemId: string): string {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/final-items/${encodeURIComponent(finalItemId)}/objective-report`
}

export function ObjectiveJourneyReport({ sessionId, finalItemId, graphRevision, sourceCounts, reportedScoreFloor, slots, lang, enabled = true }: {
  readonly sessionId: string
  readonly finalItemId: string
  readonly graphRevision: number
  readonly sourceCounts?: ExpectedCounts
  readonly reportedScoreFloor?: ObjectiveJourneyReportedScoreFloor
  readonly slots: readonly ExpectedSlot[]
  readonly lang: Lang
  readonly enabled?: boolean
}) {
  const validIdentity = safeId(sessionId) && safeId(finalItemId) && Number.isSafeInteger(graphRevision) && graphRevision > 0
  const url = validIdentity ? buildObjectiveJourneyReportUrl(sessionId, finalItemId) : ''
  const query = useApi<unknown>(url, { enabled: validIdentity && enabled, cache: false })
  const response = record(query.data)
  const parsed = response ? parseObjectiveJourneyReport(response.report) : undefined
  const report = parsed && !query.error && sameReport(parsed, { finalItemId, graphRevision, sourceCounts, reportedScoreFloor, slots }) ? parsed : null
  const copy = lang === 'zh' ? zh : en
  const [missingEvidenceOrdinal, setMissingEvidenceOrdinal] = useState<number | null>(null)
  const [reportRefreshEpoch, setReportRefreshEpoch] = useState(0)
  const reportRoot = useRef<HTMLElement>(null)

  const refresh = () => {
    setMissingEvidenceOrdinal(null)
    setReportRefreshEpoch(epoch => epoch + 1)
    void query.refetch()
  }
  const openFillEvidence = (ordinal: number, evidenceFinalItemId: string) => {
    setMissingEvidenceOrdinal(focusObjectiveFillEvidence(evidenceFinalItemId) ? null : ordinal)
  }

  return <section ref={reportRoot} aria-label={copy.title} data-objective-journey-report={report ? 'available' : 'unavailable'} style={sectionStyle}>
    <h3 style={headingStyle}>{copy.title}</h3>
    {!report && <p role="status" style={statusStyle}>{query.loading && !query.error ? copy.loading : copy.unavailable}</p>}
    {report && <>
      <p role="status" style={statusStyle}>{copy.reviewCoverage}: {copy.coverage[report.reviewCoverage]}</p>
      <dl aria-label={copy.overview} style={overviewStyle}>
        <div><dt>{copy.shortlisted}</dt><dd>{report.slots.length}</dd></div>
        <div><dt>{copy.ready}</dt><dd>{report.slots.filter(slot => slot.tailoringStatus === 'ready').length}</dd></div>
        <div><dt>{copy.submitted}</dt><dd>{submittedSummary(report, copy)}</dd></div>
        {'reportedScoreFloor' in report && report.reportedScoreFloor && <div><dt>{copy.scoreFloor}</dt><dd>{scoreFloorSummary(report.reportedScoreFloor, copy)}</dd></div>}
        {'requirementEvidenceCoverage' in report && <div><dt>{copy.requirements}</dt>
          <dd>{requirementEvidenceSummary(report.requirementEvidenceCoverage, copy)}</dd></div>}
        <div><dt>{copy.unresolved}</dt><dd>{report.slots.filter(isUnresolved).length}</dd></div>
        <div><dt>{copy.materialChanged}</dt><dd>{report.slots.filter(slot => slot.retirementReason === 'resume_material_changed'
          || slot.retirementReason === 'completed_source_changed').length}</dd></div>
      </dl>
      <ol style={listStyle}>
        {report.slots.map(slot => {
          const hint = nextStep(slot, copy)
          return <li key={slot.ordinal} tabIndex={-1} data-objective-journey-slot={slot.ordinal} style={slotStyle}>
          <strong>{slot.job ? `${slot.job.company} — ${slot.job.role}` : `${copy.job} ${slot.ordinal}`}</strong>
          <dl style={detailsStyle}>
            <div><dt>{copy.tailoring}</dt><dd>{copy.tailoringStatus[slot.tailoringStatus]}</dd></div>
            <div><dt>{copy.review}</dt><dd>{copy.reviewStatus[slot.reviewStatus]}</dd></div>
            <div><dt>{copy.application}</dt><dd>{copy.applicationStatus[slot.applicationStatus]}</dd></div>
          </dl>
          {slot.retirementReason && <p style={statusStyle}>{copy.retirement}: {copy.retirementReason[slot.retirementReason]}</p>}
          {hint && <p role="note" style={statusStyle}>{hint}</p>}
          {slot.job && <ObjectiveSlotArtifact key={objectiveSlotArtifactKey(sessionId, finalItemId, graphRevision, slot.ordinal, slot.job)}
            sessionId={sessionId} finalItemId={finalItemId} graphRevision={graphRevision} slotOrdinal={slot.ordinal}
            ready={slot.tailoringStatus === 'ready'} ownedLabel={`${slot.job.company} — ${slot.job.role}`} lang={lang} />}
          {slot.submissionEvidence && <div data-objective-submission-evidence="verified" style={evidenceStyle}>
            <span>{copy.confirmedSubmission}</span>
            <button type="button" onClick={() => openFillEvidence(slot.ordinal, slot.submissionEvidence!.finalItemId)}>
              {copy.viewFillEvidence}
            </button>
            {missingEvidenceOrdinal === slot.ordinal && <p role="status">{copy.evidenceNotVisible}</p>}
          </div>}
          </li>
        })}
      </ol>
      <ObjectiveJourneySkillComparison key={objectiveJourneySkillComparisonKey({ sessionId, finalItemId, graphRevision,
        reportRefreshEpoch, report })} reportUrl={url} sessionId={sessionId} finalItemId={finalItemId}
        graphRevision={graphRevision} report={report} lang={lang} reportRoot={reportRoot} />
    </>}
    <button type="button" disabled={!validIdentity || !enabled || query.loading} onClick={refresh}>
      {query.loading ? copy.refreshing : copy.refresh}
    </button>
  </section>
}

export function focusObjectiveFillEvidence(finalItemId: string, root?: Document): boolean {
  const documentRoot = root ?? (typeof document === 'undefined' ? undefined : document)
  if (!documentRoot || !safeId(finalItemId)) return false
  const target = Array.from(documentRoot.querySelectorAll<HTMLElement>('[data-agent-harness-item]'))
    .find(item => item.getAttribute('data-agent-harness-item') === finalItemId)
  if (!target) return false
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  target.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  target.focus({ preventScroll: true })
  return true
}

function sameReport(report: Report, expected: {
  finalItemId: string; graphRevision: number; sourceCounts?: ExpectedCounts
  reportedScoreFloor?: ObjectiveJourneyReportedScoreFloor; slots: readonly ExpectedSlot[]
}): boolean {
  const actualFloor = 'reportedScoreFloor' in report ? report.reportedScoreFloor : undefined
  return report.finalItemId === expected.finalItemId && report.graphRevision === expected.graphRevision
    && (!expected.sourceCounts || sameCounts(report.sourceCounts, expected.sourceCounts))
    && sameScoreFloor(actualFloor, expected.reportedScoreFloor)
    && report.slots.length === expected.slots.length
    && report.slots.every((slot, index) => slot.ordinal === expected.slots[index]?.ordinal
      && slot.tailoringStatus === expected.slots[index]?.tailoringStatus)
}

function sameScoreFloor(actual: ObjectiveJourneyReportedScoreFloor | undefined, expected: ObjectiveJourneyReportedScoreFloor | undefined): boolean {
  if (!actual || !expected) return actual === expected
  return actual.status === expected.status && (actual.status !== 'complete' || expected.status === 'complete'
    && actual.minimumScore === expected.minimumScore && actual.qualifyingJobCount === expected.qualifyingJobCount)
}

function scoreFloorSummary(floor: ObjectiveJourneyReportedScoreFloor, copy: typeof en): string {
  if (floor.status === 'not_requested') return copy.floorNotRequested
  if (floor.status === 'unavailable') return copy.floorUnavailable
  return `≥ ${floor.minimumScore}: ${floor.qualifyingJobCount} ${copy.qualifyingJobs}`
}

function requirementEvidenceSummary(coverage: ObjectiveJourneyRequirementEvidenceCoverage, copy: typeof en): string {
  if (coverage.status === 'unavailable') return copy.requirementUnavailable
  return copy.requirementSummary(coverage.verifiedReadyJobs, coverage.checkedReadyJobs, coverage.status)
}

function sameCounts(left: ExpectedCounts, right: ExpectedCounts): boolean {
  return left.discoveredJobs.knownCount === right.discoveredJobs.knownCount
    && left.discoveredJobs.coverage === right.discoveredJobs.coverage
    && left.analyzedJobs.knownCount === right.analyzedJobs.knownCount
    && left.analyzedJobs.coverage === right.analyzedJobs.coverage
}

function isUnresolved(slot: Report['slots'][number]): boolean {
  if (slot.reviewStatus === 'pending' || slot.reviewStatus === 'unknown') return true
  return slot.reviewStatus === 'approved' && ['not_started', 'preparing', 'awaiting_submit_approval', 'uncertain', 'unknown']
    .includes(slot.applicationStatus)
}

function nextStep(slot: Report['slots'][number], copy: typeof en): string | null {
  if (slot.applicationStatus === 'awaiting_submit_approval') return copy.nextFormReview
  if (slot.applicationStatus === 'uncertain') return copy.checkEmployer
  if (slot.reviewStatus === 'pending') return copy.continueReview
  if (slot.retirementReason === 'resume_material_changed' || slot.retirementReason === 'completed_source_changed'
    || slot.retirementReason === 'resume_witness_unavailable') return copy.requestFreshReview
  return null
}

function submittedSummary(report: Report, copy: typeof en): string {
  const confirmed = report.slots.filter(slot => slot.applicationStatus === 'submitted').length
  const unknown = report.slots.some(slot => slot.applicationStatus === 'unknown')
  return `${confirmed}${unknown ? copy.outcomeUnavailableSuffix : ''}`
}

function objectiveSlotArtifactKey(sessionId: string, finalItemId: string, graphRevision: number, ordinal: number, job: { company: string; role: string }): string {
  return JSON.stringify([sessionId, finalItemId, graphRevision, ordinal, job.company, job.role])
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null } catch { return null }
}

const en = {
  title: 'Application journey', loading: 'Loading the verified application report…', unavailable: 'The application report is unavailable.',
  refreshing: 'Refreshing…', refresh: 'Refresh report', job: 'Job', reviewCoverage: 'Review coverage',
  coverage: { complete: 'Complete', partial: 'Partial', unavailable: 'Unavailable' },
  tailoring: 'Tailoring', review: 'Review', application: 'Application', retirement: 'Review expiry reason',
  confirmedSubmission: 'Submission confirmed with verified fill evidence.', viewFillEvidence: 'View fill evidence',
  evidenceNotVisible: 'The submission is confirmed, but its fill record is not visible in the current transcript.',
  overview: 'Journey totals', shortlisted: 'Shortlisted', ready: 'Ready', submitted: 'Site-confirmed', unresolved: 'Unresolved',
  scoreFloor: 'Analyst-reported score floor', floorNotRequested: 'Not requested', floorUnavailable: 'Unavailable', qualifyingJobs: 'qualifying jobs',
  requirements: 'Verified Job requirement evidence', requirementUnavailable: 'Unavailable',
  requirementSummary: (verified: number, checked: number, coverage: 'complete' | 'partial') =>
    `${verified} verified of ${checked} checked ready Jobs (${coverage} coverage)`,
  materialChanged: 'Material changed',
  outcomeUnavailableSuffix: ' observed; some outcomes unavailable',
  nextFormReview: 'Review the filled form before deciding.', checkEmployer: 'Check the employer site before any retry.',
  continueReview: 'Continue this review in Approvals.', requestFreshReview: 'The material changed; request a fresh review.',
  tailoringStatus: { ready: 'Ready', needs_revision: 'Needs revision', rejected: 'Rejected', stale: 'Out of date', failed: 'Failed' },
  reviewStatus: { not_requested: 'Not requested', pending: 'Pending', approved: 'Approved', rejected: 'Rejected', expired: 'Expired', unknown: 'Unavailable' },
  applicationStatus: { not_started: 'Not started', preparing: 'Preparing', awaiting_submit_approval: 'Awaiting submission approval',
    submitted: 'Site-confirmed', uncertain: 'Uncertain', failed: 'Failed', unknown: 'Unavailable' },
  retirementReason: { approval_ttl_reached: 'Approval expired', approval_revision_changed: 'Approval changed',
    resume_witness_unavailable: 'Resume could not be verified', resume_material_changed: 'Resume changed after review',
    completed_source_changed: 'Tailoring source changed after review' },
}
const zh = {
  title: '申请进度汇总', loading: '正在读取已验证的申请报告…', unavailable: '暂时无法读取申请报告。',
  refreshing: '正在刷新…', refresh: '刷新报告', job: '职位', reviewCoverage: '审核覆盖',
  coverage: { complete: '完整', partial: '部分', unavailable: '不可用' },
  tailoring: '定制', review: '审核', application: '申请', retirement: '审批失效原因',
  confirmedSubmission: '已通过验证确认提交。', viewFillEvidence: '查看填写记录',
  evidenceNotVisible: '已确认提交，但当前对话记录中没有显示填写记录。',
  overview: '申请进度', shortlisted: '已列入清单', ready: '已就绪', submitted: '网站已确认', unresolved: '待确认',
  scoreFloor: '分析师报告的评分下限', floorNotRequested: '未请求', floorUnavailable: '不可用', qualifyingJobs: '个符合条件的职位',
  requirements: '已验证的职位要求证据', requirementUnavailable: '不可用',
  requirementSummary: (verified: number, checked: number, coverage: 'complete' | 'partial') =>
    `${checked} 个已检查的就绪职位中，${verified} 个职位的要求证据已验证（${coverage === 'complete' ? '完整覆盖' : '部分覆盖'}）`,
  materialChanged: '材料已变更',
  outcomeUnavailableSuffix: ' 条已确认；部分结果不可用',
  nextFormReview: '请先检查已填写的表单。', checkEmployer: '重试前请先查看雇主网站。',
  continueReview: '请在审核页面继续此审核。', requestFreshReview: '材料已变更，请重新请求审核。',
  tailoringStatus: { ready: '已就绪', needs_revision: '需要修改', rejected: '未通过', stale: '已过期', failed: '失败' },
  reviewStatus: { not_requested: '未请求', pending: '等待中', approved: '已批准', rejected: '已拒绝', expired: '已过期', unknown: '不可用' },
  applicationStatus: { not_started: '未开始', preparing: '准备中', awaiting_submit_approval: '等待提交批准',
    submitted: '网站已确认', uncertain: '状态不确定', failed: '失败', unknown: '不可用' },
  retirementReason: { approval_ttl_reached: '批准已过期', approval_revision_changed: '批准信息已变更',
    resume_witness_unavailable: '无法验证简历', resume_material_changed: '审核后简历已修改',
    completed_source_changed: '审核后定制来源已变更' },
}
const sectionStyle: React.CSSProperties = { display: 'grid', gap: 6, color: 'var(--text)', marginTop: 10 }
const headingStyle: React.CSSProperties = { margin: 0, fontSize: 13 }
const statusStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 12 }
const listStyle: React.CSSProperties = { display: 'grid', gap: 8, margin: '4px 0', paddingLeft: 22 }
const slotStyle: React.CSSProperties = { padding: 8, border: '1px solid var(--border)', borderRadius: 6 }
const detailsStyle: React.CSSProperties = { display: 'grid', gap: 3, margin: '4px 0' }
const overviewStyle: React.CSSProperties = { display: 'flex', gap: 16, flexWrap: 'wrap', margin: '4px 0' }
const evidenceStyle: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
