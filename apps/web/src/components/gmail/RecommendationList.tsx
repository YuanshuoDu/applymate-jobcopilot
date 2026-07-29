'use client'

import React from 'react'
import { ChevronDown, ExternalLink, Mail, X } from 'lucide-react'
import type { GmailRecommendation } from './types'
import { displayPlatform, groupRecommendations } from './recommendations-model'

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
  const selectable = recommendations.filter(item => item.status === 'pending' && item.company && item.role)
  const allSelected = selectable.length > 0 && selectable.every(item => selectedIds.has(item.id))

  return <div className="recommendation-table-wrap">
    <table className="recommendation-table">
      <colgroup>
        <col className="recommendation-col-check" /><col className="recommendation-col-role" /><col className="recommendation-col-sender" />
        <col className="recommendation-col-source" /><col className="recommendation-col-location" /><col className="recommendation-col-type" />
        <col className="recommendation-col-experience" /><col className="recommendation-col-match" /><col className="recommendation-col-actions" />
      </colgroup>
      <thead><tr>
        <th className="recommendation-check"><input aria-label="Select all visible jobs" type="checkbox" checked={allSelected} onChange={onToggleAll} /></th>
        <th>Role &amp; company</th><th>Source (email sender)</th><th>Source</th><th>Location</th><th>Type</th><th>Experience</th><th>Match</th><th>Actions</th>
      </tr></thead>
      <tbody>{recommendations.length === 0 ? <tr><td colSpan={9} className="recommendation-empty">No jobs match these filters.</td></tr>
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
    <tr className="recommendation-group"><th colSpan={9}>{group.label} <span>({group.recommendations.length})</span></th></tr>
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
  const canSave = Boolean(item.company && item.role && item.status === 'pending')
  return <>
    <tr className={`${expanded ? 'is-expanded ' : ''}${selected ? 'is-selected' : ''}`.trim() || undefined} onClick={() => onExpand(item.id)}>
      <td className="recommendation-check" onClick={event => event.stopPropagation()}><input aria-label={`Select ${item.role ?? 'job'}`} type="checkbox" checked={selected} disabled={!canSave} onChange={() => onToggle(item.id)} /></td>
      <td><strong>{item.role ?? 'Role details needed'}</strong><span>{item.company ?? 'Company details needed'}</span></td>
      <td><span className="recommendation-sender">{item.sourceMessage.senderName || item.sourceMessage.subject}</span><small>{item.sourceMessage.senderEmail || item.sourceMessage.subject}</small></td>
      <td><span className="recommendation-platform">{displayPlatform(item.platform)}</span></td>
      <td>{item.location ?? '—'}</td><td>{employmentType(item.description)}</td><td>{experience(item.description)}</td>
      <td><MatchValue value={item.sourceMessage.matchConfidence} /></td>
      <td className="recommendation-actions" onClick={event => event.stopPropagation()}>
        {canSave && <button type="button" disabled={busy} onClick={() => onAction(item.id, 'save')}>{busy ? 'Saving…' : 'Save'}</button>}
        {item.status === 'pending' && <button type="button" disabled={busy} onClick={() => onAction(item.id, 'dismiss')}>Dismiss</button>}
        {item.status === 'saved' && <span>Saved</span>}
      </td>
    </tr>
    {expanded && <tr className="recommendation-expanded"><td /><td colSpan={8}><div>
      <span><ChevronDown size={14} /> Salary: {item.salary || 'Not provided'}</span><span><Mail size={14} /> Email subject: {item.sourceMessage.subject}</span>
      {item.description && <p>{item.description}</p>}
      {item.url && <a href={item.url} target="_blank" rel="noreferrer">View job <ExternalLink size={13} /></a>}
      {item.status === 'pending' && <button type="button" disabled={busy} onClick={() => onAction(item.id, 'dismiss')}><X size={13} /> Dismiss job</button>}
    </div></td></tr>}
  </>
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
