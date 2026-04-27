'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import type { Resume } from '@/lib/types'

export default function PrintResumePage() {
  const params  = useParams<{ id: string }>()
  const [resume,  setResume]  = useState<Resume | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/resume/${params.id}`)
      .then(r => { if (!r.ok) throw new Error('Not found'); return r.json() })
      .then(setResume)
      .catch(() => setError('Could not load resume — make sure you are signed in.'))
      .finally(() => setLoading(false))
  }, [params.id])

  // Auto-trigger print once resume loads
  useEffect(() => {
    if (!resume) return
    const t = setTimeout(() => window.print(), 700)
    return () => clearTimeout(t)
  }, [resume])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui', color: '#555' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 28, height: 28, border: '3px solid #e5e7eb', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '0 auto 12px' }} />
        <div>Preparing PDF…</div>
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

  const c        = resume.content
  const template = resume.templateId ?? 'minimal'

  return (
    <>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #f3f4f6; font-family: 'Georgia', 'Times New Roman', serif; }

        /* ── Toolbar ── */
        .toolbar {
          display: flex; gap: 8px; justify-content: center; align-items: center;
          padding: 10px 16px; background: #fff; border-bottom: 1px solid #e5e7eb;
          position: sticky; top: 0; z-index: 10;
        }
        .toolbar span { font-size: 12px; color: #6b7280; margin-right: 8px; }
        .tb-btn { padding: 5px 14px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; font-size: 12px; }
        .tb-btn.primary { background: #185FA5; color: #fff; border-color: #185FA5; font-weight: 500; }

        /* ── Shared page ── */
        .page { max-width: 794px; margin: 24px auto; background: #fff; min-height: 1123px; }

        /* ── Minimal template ── */
        .minimal { padding: 52px 60px; }
        .minimal h1 { font-size: 26px; font-weight: 700; margin: 0 0 3px; letter-spacing: -0.5px; }
        .minimal .contact-row { font-size: 11px; color: #666; display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
        .minimal .contact-row span::before { content: '·'; margin-right: 10px; }
        .minimal .contact-row span:first-child::before { content: ''; margin: 0; }
        .sec { font-size: 10px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #1a1a1a; border-bottom: 1.5px solid #1a1a1a; padding-bottom: 3px; margin: 20px 0 10px; }
        .summary-text { font-size: 12px; line-height: 1.75; color: #444; margin: 0; }
        .exp-row { display: flex; justify-content: space-between; align-items: baseline; }
        .exp-role { font-size: 13px; font-weight: 600; }
        .exp-co { font-size: 12px; color: #555; }
        .exp-period { font-size: 11px; color: #888; }
        ul.bullets { margin: 5px 0 14px 16px; padding: 0; }
        ul.bullets li { font-size: 12px; line-height: 1.65; color: #444; margin-bottom: 2px; }
        .skills-wrap { display: flex; flex-wrap: wrap; gap: 5px; }
        .skill-tag { font-size: 11px; background: #f3f4f6; border: 0.5px solid #e5e7eb; border-radius: 4px; padding: 2px 8px; }
        .edu-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
        .edu-deg { font-size: 12px; font-weight: 600; }
        .edu-inst { font-size: 11px; color: #666; }
        .edu-yr { font-size: 11px; color: #888; }

        /* ── Modern template ── */
        .modern .page { padding: 0; display: grid; grid-template-columns: 230px 1fr; }
        .modern .sidebar { background: #1a3558; color: #fff; padding: 44px 24px; }
        .modern .sidebar h1 { color: #fff; font-size: 21px; font-weight: 700; margin: 0 0 4px; }
        .modern .sidebar .role-line { font-size: 12px; color: rgba(255,255,255,0.65); margin-bottom: 20px; }
        .modern .sidebar .sec { color: rgba(255,255,255,0.55); border-color: rgba(255,255,255,0.2); letter-spacing: 1.5px; }
        .modern .sidebar .contact-row { flex-direction: column; gap: 5px; margin-bottom: 0; }
        .modern .sidebar .contact-row span::before { content: ''; margin: 0; }
        .modern .sidebar .skill-tag { background: rgba(255,255,255,0.12); border-color: transparent; color: rgba(255,255,255,0.9); }
        .modern .sidebar .edu-deg { color: #fff; font-size: 12px; }
        .modern .sidebar .edu-inst { color: rgba(255,255,255,0.65); }
        .modern .sidebar .edu-yr { color: rgba(255,255,255,0.45); }
        .modern .main-col { padding: 44px 36px; }

        /* ── Compact template ── */
        .compact { font-family: 'Arial', 'Helvetica', sans-serif; padding: 32px 44px; }
        .compact h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; margin: 0 0 2px; }
        .compact .header-rule { border: none; border-top: 2px solid #1a1a1a; margin: 6px 0 10px; }
        .compact .contact-inline { font-size: 10px; color: #555; }
        .compact .sec { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #333; border-bottom: 1px solid #333; padding-bottom: 2px; margin: 14px 0 7px; font-family: 'Arial', sans-serif; }
        .compact .summary-text { font-size: 11px; line-height: 1.6; }
        .compact .exp-role { font-size: 12px; }
        .compact .exp-co { font-size: 11px; }
        .compact .exp-period { font-size: 10px; }
        .compact ul.bullets { margin: 3px 0 10px 14px; }
        .compact ul.bullets li { font-size: 11px; line-height: 1.55; margin-bottom: 1px; }
        .compact .skill-tag { display: none; }
        .compact .skills-inline { font-size: 11px; line-height: 1.6; color: #444; }

        @media print {
          @page { size: A4; margin: 0; }
          body { background: #fff; }
          .toolbar { display: none; }
          .page { margin: 0; box-shadow: none; }
          @keyframes spin {}
        }
      `}</style>

      {/* Toolbar */}
      <div className="toolbar">
        <span>{resume.name}</span>
        <button className="tb-btn" onClick={() => window.close()}>✕ Close</button>
        <button className="tb-btn primary" onClick={() => window.print()}>⬇ Save as PDF</button>
      </div>

      {/* ── MINIMAL ── */}
      {template !== 'modern' && template !== 'compact' && (
        <div className="page minimal">
          <h1>{c.contact.name || 'Your Name'}</h1>
          <div className="contact-row">
            {c.contact.email    && <span>{c.contact.email}</span>}
            {c.contact.phone    && <span>{c.contact.phone}</span>}
            {c.contact.location && <span>{c.contact.location}</span>}
            {c.contact.linkedin && <span>LinkedIn</span>}
            {c.contact.github   && <span>GitHub</span>}
          </div>

          {c.summary && (
            <>
              <div className="sec">Summary</div>
              <p className="summary-text">{c.summary}</p>
            </>
          )}

          {c.experience.length > 0 && (
            <>
              <div className="sec">Experience</div>
              {c.experience.map((exp, i) => (
                <div key={i} style={{ marginBottom: 14 }}>
                  <div className="exp-row">
                    <div>
                      <div className="exp-role">{exp.role}</div>
                      <div className="exp-co">{exp.company}</div>
                    </div>
                    <div className="exp-period">{exp.period}</div>
                  </div>
                  <ul className="bullets">{exp.bullets.filter(Boolean).map((b, j) => <li key={j}>{b}</li>)}</ul>
                </div>
              ))}
            </>
          )}

          {c.skills.length > 0 && (
            <>
              <div className="sec">Skills</div>
              <div className="skills-wrap">{c.skills.map(s => <span key={s} className="skill-tag">{s}</span>)}</div>
            </>
          )}

          {c.education.length > 0 && (
            <>
              <div className="sec">Education</div>
              {c.education.map((e, i) => (
                <div key={i} className="edu-row">
                  <div><div className="edu-deg">{e.degree}</div><div className="edu-inst">{e.institution}</div></div>
                  <div className="edu-yr">{e.year}</div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── MODERN ── */}
      {template === 'modern' && (
        <div className="modern">
          <div className="page">
            {/* Sidebar */}
            <div className="sidebar">
              <h1>{c.contact.name || 'Your Name'}</h1>
              {c.experience[0] && <div className="role-line">{c.experience[0].role}</div>}

              <div className="sec">Contact</div>
              <div className="contact-row">
                {c.contact.email    && <span>{c.contact.email}</span>}
                {c.contact.phone    && <span>{c.contact.phone}</span>}
                {c.contact.location && <span>{c.contact.location}</span>}
                {c.contact.linkedin && <span>LinkedIn</span>}
                {c.contact.github   && <span>GitHub</span>}
              </div>

              {c.skills.length > 0 && (
                <>
                  <div className="sec">Skills</div>
                  <div className="skills-wrap">{c.skills.map(s => <span key={s} className="skill-tag">{s}</span>)}</div>
                </>
              )}

              {c.education.length > 0 && (
                <>
                  <div className="sec">Education</div>
                  {c.education.map((e, i) => (
                    <div key={i} style={{ marginBottom: 12 }}>
                      <div className="edu-deg">{e.degree}</div>
                      <div className="edu-inst">{e.institution}</div>
                      <div className="edu-yr">{e.year}</div>
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* Main column */}
            <div className="main-col">
              {c.summary && (
                <>
                  <div className="sec">Profile</div>
                  <p className="summary-text">{c.summary}</p>
                </>
              )}
              {c.experience.length > 0 && (
                <>
                  <div className="sec">Experience</div>
                  {c.experience.map((exp, i) => (
                    <div key={i} style={{ marginBottom: 16 }}>
                      <div className="exp-row">
                        <div><div className="exp-role">{exp.role}</div><div className="exp-co">{exp.company}</div></div>
                        <div className="exp-period">{exp.period}</div>
                      </div>
                      <ul className="bullets">{exp.bullets.filter(Boolean).map((b, j) => <li key={j}>{b}</li>)}</ul>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── COMPACT ── */}
      {template === 'compact' && (
        <div className="page compact">
          <h1>{c.contact.name || 'Your Name'}</h1>
          <hr className="header-rule" />
          <div className="contact-inline">
            {[c.contact.email, c.contact.phone, c.contact.location, c.contact.linkedin && 'LinkedIn', c.contact.github && 'GitHub'].filter(Boolean).join(' · ')}
          </div>

          {c.summary && (
            <>
              <div className="sec">Profile</div>
              <p className="summary-text">{c.summary}</p>
            </>
          )}

          {c.experience.length > 0 && (
            <>
              <div className="sec">Experience</div>
              {c.experience.map((exp, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div className="exp-row">
                    <span><span className="exp-role">{exp.role}</span> <span className="exp-co">· {exp.company}</span></span>
                    <span className="exp-period">{exp.period}</span>
                  </div>
                  <ul className="bullets">{exp.bullets.filter(Boolean).map((b, j) => <li key={j}>{b}</li>)}</ul>
                </div>
              ))}
            </>
          )}

          {c.skills.length > 0 && (
            <>
              <div className="sec">Skills</div>
              <div className="skills-inline">{c.skills.join(' · ')}</div>
            </>
          )}

          {c.education.length > 0 && (
            <>
              <div className="sec">Education</div>
              {c.education.map((e, i) => (
                <div key={i} className="edu-row">
                  <span><span className="edu-deg">{e.degree}</span> <span className="edu-inst">· {e.institution}</span></span>
                  <span className="edu-yr">{e.year}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  )
}
