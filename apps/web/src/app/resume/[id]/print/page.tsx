'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { ResumeRenderer } from '@/components/resume/ResumeRenderer'
import type { Resume } from '@/lib/types'

// A4 at 96 dpi = 794 × 1123 px
const A4_H = 1123

type FitResult =
  | { type: 'too-short';    ratio: number }
  | { type: 'one-page';     ratio: number }
  | { type: 'scaled-one';   ratio: number; scale: number }
  | { type: 'two-page';     ratio: number }
  | { type: 'too-long';     ratio: number; pages: number }

function applyFit(el: HTMLDivElement): FitResult {
  const h   = el.scrollHeight
  const ratio = h / A4_H

  if (ratio < 0.5) {
    // Too sparse — pad anyway so print doesn't look broken, but warn
    el.style.minHeight = `${A4_H}px`
    return { type: 'too-short', ratio }
  }

  if (ratio <= 1.0) {
    // Pad bottom to fill exactly one page
    el.style.minHeight = `${A4_H}px`
    return { type: 'one-page', ratio }
  }

  if (ratio <= 1.15) {
    // Slight overflow → scale down to fit exactly one page
    const scale = A4_H / h
    el.style.zoom          = String(scale)
    // After zoom, CSS minHeight must compensate: visual = cssVal * scale → cssVal = A4_H / scale
    el.style.minHeight     = `${Math.ceil(A4_H / scale)}px`
    return { type: 'scaled-one', ratio, scale }
  }

  if (ratio <= 2.0) {
    // Pad bottom to fill exactly two pages
    el.style.minHeight = `${A4_H * 2}px`
    return { type: 'two-page', ratio }
  }

  // > 2 pages — best effort: fill to next whole page
  const targetPages = Math.ceil(ratio)
  el.style.minHeight = `${A4_H * targetPages}px`
  return { type: 'too-long', ratio, pages: targetPages }
}

// ── Status pill shown in the toolbar ─────────────────────────────────────────
function FitBadge({ fit }: { fit: FitResult }) {
  const pct = Math.round(fit.ratio * 100)

  const configs = {
    'too-short':  { color: '#A32D2D', bg: 'rgba(163,45,45,0.08)', border: 'rgba(163,45,45,0.2)',
                    label: `⚠ Only ${pct}% full — add more content` },
    'one-page':   { color: '#2E6B4F', bg: 'rgba(46,107,79,0.08)',  border: 'rgba(46,107,79,0.2)',
                    label: `✓ 1 page · ${pct}% full` },
    'scaled-one': { color: '#2E6B4F', bg: 'rgba(46,107,79,0.08)',  border: 'rgba(46,107,79,0.2)',
                    label: `✓ Fitted to 1 page · ${Math.round((fit as { scale: number }).scale * 100)}% zoom` },
    'two-page':   { color: '#185FA5', bg: 'rgba(24,95,165,0.08)',  border: 'rgba(24,95,165,0.2)',
                    label: `✓ 2 pages · Page 2 ${Math.round((fit.ratio - 1) * 100)}% full` },
    'too-long':   { color: '#A32D2D', bg: 'rgba(163,45,45,0.08)', border: 'rgba(163,45,45,0.2)',
                    label: `⚠ ${(fit as { pages: number }).pages} pages — consider shortening` },
  }

  const c = configs[fit.type]
  return (
    <span style={{ fontSize: 11, color: c.color, background: c.bg, border: `0.5px solid ${c.border}`, borderRadius: 12, padding: '3px 10px', whiteSpace: 'nowrap' }}>
      {c.label}
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function PrintResumePage() {
  const params = useParams<{ id: string }>()

  const [resume,  setResume]  = useState<Resume | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [fit,     setFit]     = useState<FitResult | null>(null)

  const contentRef = useRef<HTMLDivElement>(null)

  // 1. Fetch resume data
  useEffect(() => {
    fetch(`/api/resume/${params.id}`)
      .then(r => { if (!r.ok) throw new Error('Not found'); return r.json() })
      .then(setResume)
      .catch(() => setError('Could not load resume — make sure you are signed in.'))
      .finally(() => setLoading(false))
  }, [params.id])

  // 2. Once resume is rendered, measure and apply page fit
  useEffect(() => {
    if (!resume || !contentRef.current) return
    // Wait one frame for the ResumeRenderer to fully paint
    const raf = requestAnimationFrame(() => {
      if (!contentRef.current) return
      const result = applyFit(contentRef.current)
      setFit(result)
    })
    return () => cancelAnimationFrame(raf)
  }, [resume])

  // 3. Auto-print after fit is applied (skip if too sparse — user should review first)
  useEffect(() => {
    if (!fit || fit.type === 'too-short') return
    const t = setTimeout(() => window.print(), 700)
    return () => clearTimeout(t)
  }, [fit])

  // ── States ──────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui', color: '#555' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 28, height: 28, border: '3px solid #e5e7eb', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '0 auto 12px' }} />
        <div>Preparing resume…</div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )

  if (error || !resume) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui' }}>
      <div style={{ textAlign: 'center', color: '#A32D2D' }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>⚠</div>
        <div>{error ?? 'Resume not found'}</div>
        <button onClick={() => window.close()} style={{ marginTop: 16, padding: '6px 16px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer' }}>Close</button>
      </div>
    </div>
  )

  const isTwoPage = fit?.type === 'two-page' || (fit?.type === 'too-long')

  return (
    <>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #f3f4f6; font-family: system-ui, sans-serif; }

        .toolbar {
          display: flex; gap: 10px; justify-content: center; align-items: center;
          padding: 10px 20px; background: #fff; border-bottom: 1px solid #e5e7eb;
          position: sticky; top: 0; z-index: 10; flex-wrap: wrap;
        }
        .resume-name { font-size: 12px; color: #6b7280; margin-right: 4px; }
        .tb-btn { padding: 5px 14px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; font-size: 12px; }
        .tb-btn.primary { background: #185FA5; color: #fff; border-color: #185FA5; font-weight: 500; }

        /* Screen: show page shadow + page-break line */
        .page-outer { max-width: 794px; margin: 24px auto 48px; position: relative; }
        .page-wrap   { background: #fff; box-shadow: 0 2px 20px rgba(0,0,0,0.1); overflow: hidden; }

        .page-break-line {
          position: absolute; left: -20px; right: -20px;
          top: ${A4_H}px; z-index: 20; pointer-events: none;
          display: flex; align-items: center; gap: 8px;
        }
        .page-break-line::before, .page-break-line::after {
          content: ''; flex: 1; border-top: 2px dashed rgba(163,45,45,0.45);
        }
        .page-break-label {
          font-size: 10px; color: rgba(163,45,45,0.7);
          background: #f3f4f6; padding: 2px 8px; border-radius: 10px;
          border: 0.5px solid rgba(163,45,45,0.25); white-space: nowrap;
        }

        @media print {
          @page { size: A4; margin: 0; }
          body  { background: #fff; }
          .toolbar        { display: none !important; }
          .page-break-line { display: none !important; }
          .page-outer     { margin: 0; max-width: 100%; }
          .page-wrap      { box-shadow: none; }
          /* Ensure the content fills complete A4 pages */
          .page-wrap      { min-height: 297mm; }
          .page-wrap.two  { min-height: 594mm; }
        }
        @keyframes spin { to { transform: rotate(360deg) } }
      `}</style>

      {/* Toolbar */}
      <div className="toolbar">
        <span className="resume-name">{resume.name}</span>
        {fit && <FitBadge fit={fit} />}
        <button className="tb-btn" onClick={() => window.close()}>✕ Close</button>
        <button className="tb-btn primary" onClick={() => window.print()}>⬇ Save as PDF</button>
      </div>

      {/* Resume */}
      <div className="page-outer">
        {/* Page-break line between page 1 and 2 (screen only) */}
        {isTwoPage && (
          <div className="page-break-line">
            <span className="page-break-label">Page 2</span>
          </div>
        )}

        <div className={`page-wrap${isTwoPage ? ' two' : ''}`}>
          <div ref={contentRef}>
            <ResumeRenderer
              content={resume.content}
              templateId={resume.templateId}
              templateOptions={resume.templateOptions}
            />
          </div>
        </div>
      </div>
    </>
  )
}
