import { useState } from 'react'
import { Check, Linkedin, MapPin, Search, Sparkles } from 'lucide-react'
import type { ScoreResult, ScrapedJob } from '@/lib/types'
import { C, type PopupLabels } from './popup-constants'
import { companyDomain, companyInitials, sourceLabel } from './popup-utils'

export function DetectionRow({ job, labels }: { job: ScrapedJob | null; labels: PopupLabels }) {
  const isLinkedIn = job?.source === 'linkedin'
  return <div style={{ display: 'flex', alignItems: 'center', gap: 11, minHeight: 58, padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: 14, background: C.panel, boxShadow: C.shadow }}>
    <div style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 10, background: isLinkedIn ? '#0A76B8' : C.lavender, color: isLinkedIn ? '#fff' : C.primary }}>{isLinkedIn ? <Linkedin size={19} strokeWidth={2.2} /> : <Search size={18} strokeWidth={1.8} />}</div>
    <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 620, color: C.navy, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job ? (isLinkedIn ? labels.detected : `${sourceLabel(job.source)} job page detected`) : labels.notDetected}</span>
    <span aria-label={job ? 'Detected' : 'Not detected'} style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', borderRadius: '50%', background: job ? C.greenBg : '#F3F4F8', color: job ? C.green : C.subtle }}>{job ? <Check size={15} strokeWidth={2.8} /> : <Search size={14} strokeWidth={1.8} />}</span>
  </div>
}

export function JobSummary({ job, score, labels }: { job: ScrapedJob; score: number | null; labels: PopupLabels }) {
  const [logoFailed, setLogoFailed] = useState(false)
  const summary = score == null ? labels.readyToAnalyze : score >= 80 ? labels.strongFit : score >= 60 ? 'Good fit — review the role details.' : 'Review this role carefully before applying.'
  return <section style={{ marginTop: 12, padding: '18px 14px 14px', border: `1px solid ${C.border}`, borderRadius: 16, background: C.panel, boxShadow: C.shadow }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 64, height: 64, display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0, borderRadius: 14, background: '#131313', color: '#fff', fontWeight: 650, fontSize: job.company.length > 4 ? 12 : 18 }}>
        {!logoFailed && <img src={companyDomain(job.company)} alt={`${job.company} logo`} onError={() => setLogoFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
        {logoFailed && companyInitials(job.company)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, lineHeight: 1.22, fontWeight: 730, color: C.navy, letterSpacing: '-0.025em', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{job.title}</div>
        <div style={{ marginTop: 5, fontSize: 14, color: C.muted, fontWeight: 520 }}>{job.company}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, fontSize: 12, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><MapPin size={14} strokeWidth={1.8} />{job.location || 'Location not listed'}</div>
      </div>
      <ScoreRing score={score} labels={labels} />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 16, padding: '11px 12px', borderRadius: 11, background: score == null ? C.lavender : C.greenBg, color: score == null ? C.primary : C.green }}>
      <span style={{ width: 22, height: 22, display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: '50%', background: score == null ? 'rgba(81,70,229,0.12)' : '#43B985' }}>{score == null ? <Sparkles size={13} strokeWidth={2} /> : <Check size={14} strokeWidth={2.8} color="#fff" />}</span>
      <span style={{ fontSize: 13, fontWeight: 640, lineHeight: 1.3 }}>{summary}</span>
    </div>
  </section>
}

function ScoreRing({ score, labels }: { score: number | null; labels: PopupLabels }) {
  const value = score == null ? 0 : Math.max(0, Math.min(100, score))
  const radius = 25
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (value / 100) * circumference
  return <div role="img" aria-label={score == null ? labels.readyToAnalyze : `${score}% ${labels.match.toLowerCase()}`} style={{ position: 'relative', width: 70, height: 70, flexShrink: 0 }}>
    <svg width="70" height="70" viewBox="0 0 70 70" style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
      <circle cx="35" cy="35" r={radius} fill="none" stroke="#E6E8F5" strokeWidth="6" />
      {score != null && <circle cx="35" cy="35" r={radius} fill="none" stroke={C.green} strokeWidth="6" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} />}
    </svg>
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}><strong style={{ fontSize: score == null ? 16 : 17, color: score == null ? C.subtle : C.navy, lineHeight: 1 }}>{score == null ? '—' : `${score}%`}</strong><span style={{ position: 'absolute', top: 43, fontSize: 9, color: C.muted }}>{labels.match}</span></div>
  </div>
}
