'use client'

import React from 'react'
import { BriefcaseBusiness, Euro, ExternalLink, Mail, X } from 'lucide-react'
import type { GmailRecommendation } from './types'
import { groupRecommendations } from './recommendations-model'

interface RecommendationListProps {
  recommendations: GmailRecommendation[]
  selectedIds: Set<string>
  expandedId: string | null
  busyIds: Set<string>
  onToggle: (id: string) => void
  onToggleAll: () => void
  onExpand: (id: string) => void
  onAction: (id: string, action: 'save' | 'dismiss') => void
}

export function RecommendationList({ recommendations, selectedIds, expandedId, busyIds, onToggle, onToggleAll, onExpand, onAction }: RecommendationListProps) {
  const selectable = recommendations.filter(item => item.status === 'pending')
  const allSelected = selectable.length > 0 && selectable.every(item => selectedIds.has(item.id))

  return <div className="recommendation-table-wrap">
    <table className="recommendation-table">
      <colgroup>
        <col className="recommendation-col-check" /><col className="recommendation-col-role" /><col className="recommendation-col-source" />
        <col className="recommendation-col-location" /><col className="recommendation-col-type" />
        <col className="recommendation-col-experience" /><col className="recommendation-col-match" /><col className="recommendation-col-actions" />
      </colgroup>
      <thead><tr>
        <th className="recommendation-check"><input aria-label="Select all visible jobs" type="checkbox" checked={allSelected} onChange={onToggleAll} /></th>
        <th>Role &amp; company</th><th>Source</th><th>Location</th><th>Type</th><th>Experience</th><th>Match</th><th>Actions</th>
      </tr></thead>
      <tbody>{recommendations.length === 0 ? <tr><td colSpan={8} className="recommendation-empty">No jobs match these filters.</td></tr>
        : groupRecommendations(recommendations).map(group => <RecommendationGroup key={group.id} {...{ group, selectedIds, expandedId, busyIds, onToggle, onExpand, onAction }} />)}</tbody>
    </table>
  </div>
}

function RecommendationGroup({ group, selectedIds, expandedId, busyIds, onToggle, onExpand, onAction }: {
  group: ReturnType<typeof groupRecommendations>[number]
  selectedIds: Set<string>
  expandedId: string | null
  busyIds: Set<string>
  onToggle: (id: string) => void
  onExpand: (id: string) => void
  onAction: (id: string, action: 'save' | 'dismiss') => void
}) {
  return <>
    <tr className="recommendation-group"><th colSpan={8}>{group.label} <span>({group.recommendations.length})</span></th></tr>
    {group.recommendations.map(item => <RecommendationRow key={item.id} item={item} selected={selectedIds.has(item.id)} expanded={expandedId === item.id} busy={busyIds.has(item.id)} {...{ onToggle, onExpand, onAction }} />)}
  </>
}

function RecommendationRow({ item, selected, expanded, busy, onToggle, onExpand, onAction }: {
  item: GmailRecommendation
  selected: boolean
  expanded: boolean
  busy: boolean
  onToggle: (id: string) => void
  onExpand: (id: string) => void
  onAction: (id: string, action: 'save' | 'dismiss') => void
}) {
  const canSave = item.status === 'pending'
  return <>
    <tr className={`${expanded ? 'is-expanded ' : ''}${selected ? 'is-selected' : ''}`.trim() || undefined} onClick={() => onExpand(item.id)}>
      <td className="recommendation-check" onClick={event => event.stopPropagation()}><input aria-label={`Select ${item.role ?? 'job'}`} type="checkbox" checked={selected} disabled={!canSave} onChange={() => onToggle(item.id)} /></td>
      <td><strong>{item.role ?? 'Role details needed'}</strong><span>{item.company ?? 'Details fetched when saved'}</span></td>
      <td className="recommendation-source"><PlatformIcon platform={item.platform} /></td>
      <td>{item.location ?? '—'}</td><td>{employmentType(item.description)}</td><td>{experience(item.description)}</td>
      <td><MatchValue value={item.sourceMessage.matchConfidence} /></td>
      <td className="recommendation-actions" onClick={event => event.stopPropagation()}>
        {canSave && <button className="recommendation-save" type="button" disabled={busy} onClick={() => onAction(item.id, 'save')}>{busy ? 'Saving…' : 'Save'}</button>}
        {item.status === 'pending' && <button className="recommendation-dismiss" type="button" disabled={busy} onClick={() => onAction(item.id, 'dismiss')}>Dismiss</button>}
        {item.status === 'saved' && <span>Saved</span>}
      </td>
    </tr>
    {expanded && <tr className="recommendation-expanded"><td /><td colSpan={7}><div>
      <span className="recommendation-expanded-salary"><Euro size={14} /><small>Salary (est.)</small><strong>{item.salary || 'Not provided'}</strong></span>
      <i className="recommendation-expanded-divider" aria-hidden="true" />
      <a className="recommendation-expanded-email" href={sourceEmailHref(item.sourceMessage.gmailMessageId)} target="_blank" rel="noreferrer"><Mail size={14} /><small>Source email</small><strong>Open source email</strong></a>
      {item.url && <><i className="recommendation-expanded-divider" aria-hidden="true" /><a className="recommendation-expanded-job" href={item.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /><small>Job page</small><strong>View job</strong></a></>}
      <button type="button" aria-label="Close job details" disabled={busy} onClick={() => onExpand(item.id)}><X size={14} /></button>
    </div></td></tr>}
  </>
}

function sourceEmailHref(messageId: string) {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(messageId)}`
}

function PlatformIcon({ platform }: { platform: string | null }) {
  const source = platformSource(platform)
  if (!source) return <span className="recommendation-source-fallback" title={platform ?? 'Job platform'}><BriefcaseBusiness size={15} /></span>
  // eslint-disable-next-line @next/next/no-img-element -- fixed third-party favicon domains avoid Next image host configuration.
  return <img src={`https://www.google.com/s2/favicons?domain=${source.domain}&sz=64`} alt={`${source.label} logo`} title={source.label} />
}

function platformSource(platform: string | null) {
  const value = platform?.toLowerCase().replace(/[^a-z]/g, '') ?? ''
  if (value.includes('linkedin')) return { label: 'LinkedIn', domain: 'linkedin.com' }
  if (value.includes('indeed')) return { label: 'Indeed', domain: 'indeed.com' }
  if (value.includes('gradireland')) return { label: 'GradIreland', domain: 'gradireland.com' }
  if (value.includes('irishjobs')) return { label: 'IrishJobs', domain: 'irishjobs.ie' }
  if (value === 'jobsie') return { label: 'Jobs.ie', domain: 'jobs.ie' }
  if (value.includes('stepstone')) return { label: 'StepStone', domain: 'stepstone.de' }
  return null
}

function MatchValue({ value }: { value: number | null }) {
  if (value === null) return <span className="recommendation-no-match">Not scored</span>
  const score = Math.round(value <= 1 ? value * 100 : value)
  return <span className="recommendation-match"><strong>{score}%</strong><i style={{ width: `${Math.max(0, Math.min(score, 100))}%` }} /></span>
}

function employmentType(description: string | null) {
  if (!description) return '—'
  return /part[-\s]?time/i.test(description) ? 'Part-time' : /contract/i.test(description) ? 'Contract' : /full[-\s]?time/i.test(description) ? 'Full-time' : '—'
}

function experience(description: string | null) {
  const match = description?.match(/\b(\d+)(?:\s*[-–]\s*(\d+))?\+?\s*(?:years?|yrs?)(?:\s+of)?\s+experience/i)
  if (!match) return '—'
  return match[2] ? `${match[1]}–${match[2]} years` : `${match[1]}+ years`
}
