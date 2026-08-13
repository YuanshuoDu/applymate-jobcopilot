import { useState } from 'react'
import { Check, Linkedin, MapPin, Search, Sparkles } from 'lucide-react'
import type { ScoreResult, ScrapedJob } from '@/lib/types'
import { scoreColorsFor } from '@/lib/score-colors'
import { C, type PopupLabels } from './popup-constants'
import { companyDomain, companyInitials, sourceLabel } from './popup-utils'

export function DetectionRow({ job, labels }: { job: ScrapedJob | null; labels: PopupLabels }) {
  const isLinkedIn = job?.source === 'linkedin'
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 42, padding: '5px 9px', border: `1px solid ${C.border}`, borderRadius: 11, background: C.panel, boxShadow: C.shadow }}>
    <div style={{ width: 28, height: 28, display: 'grid', placeItems: 'center', borderRadius: 8, background: isLinkedIn ? '#0A76B8' : C.lavender, color: isLinkedIn ? '#fff' : C.primary }}>{isLinkedIn ? <Linkedin size={16} strokeWidth={2.2} /> : <Search size={15} strokeWidth={1.8} />}</div>
    <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 620, color: C.navy, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job ? (isLinkedIn ? labels.detected : `${sourceLabel(job.source)} job page detected`) : labels.notDetected}</span>
    <span aria-label={job ? 'Detected' : 'Not detected'} style={{ width: 21, height: 21, display: 'grid', placeItems: 'center', borderRadius: '50%', background: job ? C.greenBg : '#F3F4F8', color: job ? C.green : C.subtle }}>{job ? <Check size={13} strokeWidth={2.8} /> : <Search size={12} strokeWidth={1.8} />}</span>
  </div>
}

export function JobSummary({ job, score, labels }: { job: ScrapedJob; score: number | null; labels: PopupLabels }) {
  const [logoFailed, setLogoFailed] = useState(false)
  const scoreColors = score == null ? null : scoreColorsFor(score)
  const summary = score == null ? labels.readyToAnalyze : scoreColors?.tone === 'strong' ? labels.strongFit : scoreColors?.tone === 'normal' ? 'Good fit — review the role details.' : 'Review this role carefully before applying.'
  return <section style={{ marginTop: 10, padding: '14px 12px 12px', border: `1px solid ${C.border}`, borderRadius: 14, background: C.panel, boxShadow: C.shadow }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 56, height: 56, display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0, borderRadius: 13, background: '#131313', color: '#fff', fontWeight: 650, fontSize: job.company.length > 4 ? 11 : 16 }}>
        {!logoFailed && <img src={companyDomain(job.company)} alt={`${job.company} logo`} onError={() => setLogoFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
        {logoFailed && companyInitials(job.company)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, lineHeight: 1.2, fontWeight: 730, color: C.navy, letterSpacing: '-0.025em', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{job.title}</div>
        <div style={{ marginTop: 3, fontSize: 12, color: C.muted, fontWeight: 520 }}>{job.company}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 11, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><MapPin size={12} strokeWidth={1.8} />{job.location || 'Location not listed'}</div>
      </div>
      <ScoreRing score={score} labels={labels} />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11, padding: '8px 10px', borderRadius: 10, background: scoreColors?.background ?? C.lavender, color: scoreColors?.color ?? C.primary }}>
      <span style={{ width: 20, height: 20, display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: '50%', background: scoreColors?.color ?? 'rgba(81,70,229,0.12)' }}>{score == null ? <Sparkles size={12} strokeWidth={2} /> : <Check size={13} strokeWidth={2.8} color="#fff" />}</span>
      <span style={{ fontSize: 11.5, fontWeight: 640, lineHeight: 1.3 }}>{summary}</span>
    </div>
  </section>
}

function ScoreRing({ score, labels }: { score: number | null; labels: PopupLabels }) {
  const value = score == null ? 0 : Math.max(0, Math.min(100, score))
  const scoreColors = score == null ? null : scoreColorsFor(score)
  const radius = 22
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (value / 100) * circumference
  return <div role="img" aria-label={score == null ? labels.readyToAnalyze : `${score}% ${labels.match.toLowerCase()}`} style={{ position: 'relative', width: 62, height: 62, flexShrink: 0 }}>
    <svg width="62" height="62" viewBox="0 0 62 62" style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
      <circle cx="31" cy="31" r={radius} fill="none" stroke="rgba(0,0,0,0.07)" strokeWidth="5" />
      {score != null && <circle cx="31" cy="31" r={radius} fill="none" stroke={scoreColors?.color} strokeWidth="5" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} />}
    </svg>
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}><strong style={{ fontSize: score == null ? 14 : 15, color: scoreColors?.color ?? C.subtle, lineHeight: 1 }}>{score == null ? '—' : `${score}%`}</strong><span style={{ position: 'absolute', top: 38, fontSize: 8, color: C.muted }}>{labels.match}</span></div>
  </div>
}
