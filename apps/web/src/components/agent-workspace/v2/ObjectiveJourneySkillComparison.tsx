'use client'

import React, { useEffect, useRef, useState } from 'react'
import {
  parseObjectiveJourneySkillComparison,
  type ObjectiveJourneySkillComparison as Comparison,
} from '@/lib/agent/session/objective-journey-skill-comparison-contract'
import type { ObjectiveJourneyReport as JourneyReport } from '@/lib/agent/session/objective-journey-report-contract'
import type { Lang } from '@/lib/i18n'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type State = Readonly<{ status: 'idle' | 'pending' | 'ready' | 'unavailable'; comparison?: Comparison }>
type Props = Readonly<{
  reportUrl: string; sessionId: string; finalItemId: string; graphRevision: number
  report: JourneyReport; lang: Lang; reportRoot: React.RefObject<HTMLElement | null>
}>

export function ObjectiveJourneySkillComparison({ reportUrl, sessionId, finalItemId, graphRevision, report, lang, reportRoot }: Props) {
  const readySlotOrdinals = report.slots.filter(slot => slot.tailoringStatus === 'ready').map(slot => slot.ordinal)
  const [state, setState] = useState<State>({ status: 'idle' })
  const requestController = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => requestController.current?.abort()
  }, [])

  const visible = state
  const copy = lang === 'zh' ? zh : en
  const compare = async () => {
    if (visible.status === 'pending' || requestController.current || !reportUrl || readySlotOrdinals.length === 0) return
    const controller = new AbortController()
    requestController.current = controller
    setState({ status: 'pending' })
    try {
      const parsed = await requestObjectiveJourneySkillComparison({ url: reportUrl, graphRevision, signal: controller.signal })
      const comparison = bindObjectiveJourneySkillComparison(parsed, { finalItemId, graphRevision, readySlotOrdinals })
      if (controller.signal.aborted) return
      setState(comparison ? { status: 'ready', comparison } : { status: 'unavailable' })
    } catch {
      if (!controller.signal.aborted) setState({ status: 'unavailable' })
    } finally {
      if (requestController.current === controller) requestController.current = null
    }
  }

  return <section aria-label={copy.title} data-objective-skill-comparison={visible.status} style={sectionStyle}>
    <h4 style={headingStyle}>{copy.title}</h4>
    <p style={statusStyle}>{copy.description}</p>
    <button type='button' onClick={() => void compare()} disabled={visible.status === 'pending' || !reportUrl || readySlotOrdinals.length === 0}>
      {visible.status === 'pending' ? copy.comparing : copy.compare}
    </button>
    {visible.status === 'pending' && <p role='status' style={statusStyle}>{copy.waiting}</p>}
    {visible.status === 'unavailable' && <p role='status' style={statusStyle}>{copy.unavailable}</p>}
    {visible.comparison && <ComparisonResult comparison={visible.comparison} copy={copy} reportRoot={reportRoot} />}
  </section>
}

export function objectiveJourneySkillComparisonKey(input: {
  sessionId: string; finalItemId: string; graphRevision: number; reportRefreshEpoch: number; report: JourneyReport
}): string {
  return JSON.stringify([input.sessionId, input.finalItemId, input.graphRevision, input.reportRefreshEpoch,
    input.report.sourceCounts, input.report.reviewCoverage, input.report.slots.map(slot => [slot.ordinal, slot.tailoringStatus,
      slot.job?.company ?? null, slot.job?.role ?? null, slot.reviewStatus, slot.reviewTurnId, slot.retirementReason,
      slot.applicationStatus, slot.submissionEvidence?.fillTurnId ?? null, slot.submissionEvidence?.finalItemId ?? null])])
}

export async function requestObjectiveJourneySkillComparison(input: {
  url: string; graphRevision: number; signal?: AbortSignal; fetcher?: Fetcher
}): Promise<Comparison | undefined> {
  const response = await (input.fetcher ?? fetch)(input.url, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ compareConfirmedSkills: true, graphRevision: input.graphRevision }), signal: input.signal })
  const payload = await response.json().catch(() => null) as unknown
  const row = record(payload)
  return response.ok && row ? parseObjectiveJourneySkillComparison(row.comparison) : undefined
}

export function bindObjectiveJourneySkillComparison(comparison: Comparison | undefined, expected: {
  finalItemId: string; graphRevision: number; readySlotOrdinals: readonly number[]
}): Comparison | undefined {
  if (!comparison || comparison.finalItemId !== expected.finalItemId || comparison.graphRevision !== expected.graphRevision) return undefined
  const ready = new Set(expected.readySlotOrdinals)
  return comparison.skills.every(skill => skill.slotOrdinals.every(ordinal => ready.has(ordinal))) ? comparison : undefined
}

export function focusObjectiveJourneyJobSlot(ordinal: number, root?: ParentNode | null): boolean {
  if (!root || !Number.isSafeInteger(ordinal) || ordinal < 1) return false
  const target = root.querySelector<HTMLElement>(`[data-objective-journey-slot="${ordinal}"]`)
  if (!target) return false
  target.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  target.focus({ preventScroll: true })
  return true
}

function ComparisonResult({ comparison, copy, reportRoot }: { comparison: Comparison; copy: typeof en; reportRoot: Props['reportRoot'] }) {
  const slotButtons = (ordinals: readonly number[]) => ordinals.map(ordinal => <button key={ordinal} type='button'
    onClick={() => focusObjectiveJourneyJobSlot(ordinal, reportRoot.current)}>{copy.job} {ordinal}</button>)
  if (comparison.coverage === 'unavailable') return <div data-objective-skill-comparison-result='true' style={resultStyle}>
    <p role='status' style={statusStyle}>{copy.consentUnavailable}</p>
  </div>
  return <div data-objective-skill-comparison-result='true' style={resultStyle}>
    <p role='status' style={statusStyle}>{copy.coverage[comparison.coverage]}</p>
    {comparison.skills.length > 0 ? <ul style={listStyle}>{comparison.skills.map(skill => <li key={skill.label}>
      <strong>{skill.label}</strong> <span>{skill.evidenceStatus === 'confirmed_persona_match' ? copy.confirmed : copy.needsConfirmation}</span>
      <span style={refsStyle}>{slotButtons(skill.slotOrdinals)}</span>
    </li>)}</ul> : <p style={statusStyle}>{copy.noSkills}</p>}
    {comparison.suggestedTerms.length > 0 && <div>
      <h5 style={subheadingStyle}>{copy.suggestions}</h5>
      <ul style={listStyle}>{comparison.suggestedTerms.map(term => {
        const skill = comparison.skills.find(item => item.label === term)
        return <li key={term}><span>{term}</span>{skill && <span style={refsStyle}>{slotButtons(skill.slotOrdinals)}</span>}</li>
      })}</ul>
      <p style={statusStyle}>{copy.reviewHint}</p>
    </div>}
  </div>
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null } catch { return null }
}

const en = {
  title: 'Verified skill comparison', description: 'Compare verified Job mentions with the confirmed Skills you allowed for Job discovery.',
  compare: 'Compare with my confirmed Skills for Job discovery', comparing: 'Comparing verified mentions…', waiting: 'Checking the current report…',
  unavailable: 'This comparison is unavailable for the current report.', coverage: { complete: 'All ready Jobs checked', partial: 'Some ready Jobs checked', unavailable: 'Comparison unavailable' },
  consentUnavailable: 'Comparison is unavailable until a current, confirmed Skill field allowed for Job discovery is available.',
  confirmed: 'Confirmed in your profile', needsConfirmation: 'Needs confirmation in your profile', noSkills: 'No verified skill mentions are available in the ready Jobs.',
  suggestions: 'Reviewable next-search terms', reviewHint: 'Review these terms before using them in a search.', job: 'View Job',
}
const zh = {
  title: '已验证技能对比', description: '将已验证的职位提及与个人资料中允许用于职位发现的已确认技能进行对比。',
  compare: '对比允许用于职位发现的已确认技能', comparing: '正在对比已验证的提及…', waiting: '正在检查当前报告…',
  unavailable: '当前报告暂时无法进行对比。', coverage: { complete: '已检查全部就绪职位', partial: '已检查部分就绪职位', unavailable: '对比不可用' },
  consentUnavailable: '只有当前有效、已确认且允许用于职位发现的技能字段可用时，才能进行对比。',
  confirmed: '个人资料中已确认', needsConfirmation: '需要在个人资料中确认', noSkills: '就绪职位中没有可显示的已验证技能提及。',
  suggestions: '可审核的下一步搜索词', reviewHint: '使用这些词进行搜索前，请先审核。', job: '查看职位',
}
const sectionStyle: React.CSSProperties = { display: 'grid', gap: 6, marginTop: 10 }
const headingStyle: React.CSSProperties = { margin: 0, fontSize: 13 }
const subheadingStyle: React.CSSProperties = { margin: '8px 0 2px', fontSize: 12 }
const statusStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 12 }
const resultStyle: React.CSSProperties = { display: 'grid', gap: 5, padding: 8, border: '1px solid var(--border)', borderRadius: 6 }
const listStyle: React.CSSProperties = { display: 'grid', gap: 5, margin: 0, paddingLeft: 20 }
const refsStyle: React.CSSProperties = { display: 'inline-flex', gap: 4, flexWrap: 'wrap', marginLeft: 5 }
