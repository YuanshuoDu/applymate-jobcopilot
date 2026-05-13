'use client'

/**
 * ResumeRenderer — shared component used by:
 *  - Preview panel (live, inside the editor)
 *  - Print / PDF page
 *  - Template thumbnail previews
 *
 * Templates: clean | executive | sidebar | timeline | compact
 * Each supports: accentColor (hex), fontFamily (serif|sans|mono), density (compact|comfortable|spacious)
 */

import React from 'react'
import type { ResumeContent, TemplateOptions } from '@/lib/types'

// ── Palette ───────────────────────────────────────────────────────────────────

export const ACCENT_COLORS = [
  { id: 'blue',      label: 'Blue',       hex: '#185FA5' },
  { id: 'slate',     label: 'Slate',      hex: '#3D5A73' },
  { id: 'forest',    label: 'Forest',     hex: '#2E6B4F' },
  { id: 'terracotta',label: 'Terracotta', hex: '#A0522D' },
  { id: 'violet',    label: 'Violet',     hex: '#5B4A8A' },
  { id: 'graphite',  label: 'Graphite',   hex: '#3A3A3A' },
]

export const FONT_FAMILIES = [
  { id: 'sans',  label: 'Modern Sans',    css: "'Inter', 'Segoe UI', Arial, sans-serif" },
  { id: 'serif', label: 'Classic Serif',  css: "'Georgia', 'Times New Roman', serif"   },
  { id: 'mono',  label: 'Tech Mono',      css: "'Courier New', 'Consolas', monospace"  },
]

export const DENSITY_SCALE = {
  compact:     { pagePad: '28px 40px', secGap: 14, lineH: 1.5  },
  comfortable: { pagePad: '44px 56px', secGap: 20, lineH: 1.65 },
  spacious:    { pagePad: '60px 72px', secGap: 28, lineH: 1.75 },
}

export const TEMPLATE_DEFS = [
  { id: 'clean',     name: 'Clean',     desc: 'Modern sans-serif, accent underline' },
  { id: 'executive', name: 'Executive', desc: 'Bold header block, authoritative'    },
  { id: 'sidebar',   name: 'Sidebar',   desc: 'Two-column, colored panel'           },
  { id: 'timeline',  name: 'Timeline',  desc: 'Left timeline bar, contemporary'     },
  { id: 'compact',   name: 'Compact',   desc: 'ATS-optimized, dense'                },
]

// ── Resolved options ──────────────────────────────────────────────────────────

function resolveOpts(opts?: TemplateOptions | null) {
  const accent = opts?.accentColor ?? ACCENT_COLORS[0].hex
  const font   = FONT_FAMILIES.find(f => f.id === opts?.fontFamily) ?? FONT_FAMILIES[0]
  const den    = DENSITY_SCALE[opts?.density ?? 'comfortable']
  return { accent, font: font.css, den }
}

// ── Section rendering helpers ─────────────────────────────────────────────────

function SecTitle({ label, accent, style }: { label: string; accent: string; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontSize: 9, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase',
      color: accent, borderBottom: `1.5px solid ${accent}`, paddingBottom: 3,
      marginTop: 0, marginBottom: 10, ...style,
    }}>{label}</div>
  )
}

function ContactLine({ c, color = '#555' }: { c: ResumeContent['contact']; color?: string }) {
  const parts = [
    c.email, c.phone, c.location,
    c.linkedin ? 'linkedin.com/in/…' : null,
    c.github   ? 'github.com/…'      : null,
    c.website  ? c.website            : null,
  ].filter(Boolean) as string[]
  return (
    <div style={{ fontSize: 11, color, display: 'flex', flexWrap: 'wrap', gap: '4px 0', lineHeight: 1.8 }}>
      {parts.map((p, i) => (
        <span key={i}>{i > 0 && <span style={{ margin: '0 8px', opacity: 0.4 }}>·</span>}{p}</span>
      ))}
    </div>
  )
}

function ExperienceBlock({ exp, accent, font, lineH }: { exp: ResumeContent['experience']; accent: string; font: string; lineH: number }) {
  return (
    <>
      {exp.map((e, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 1 }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#1a1a1a' }}>{e.role}</span>
              {e.company && <span style={{ fontSize: 12, color: '#555', marginLeft: 6 }}>· {e.company}</span>}
            </div>
            <span style={{ fontSize: 10.5, color: '#888', flexShrink: 0, marginLeft: 8 }}>{e.period}</span>
          </div>
          <ul style={{ margin: '4px 0 0 14px', padding: 0 }}>
            {e.bullets.filter(Boolean).map((b, j) => (
              <li key={j} style={{ fontSize: 12, lineHeight: lineH, color: '#444', marginBottom: 2 }}>{b}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

function SkillsBlock({ skills, accent, inline }: { skills: string[]; accent: string; inline?: boolean }) {
  if (inline) {
    return <div style={{ fontSize: 11, color: '#444', lineHeight: 1.7 }}>{skills.join(' · ')}</div>
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {skills.map(s => (
        <span key={s} style={{ fontSize: 11, background: `${accent}12`, color: accent, border: `0.5px solid ${accent}30`, borderRadius: 4, padding: '2px 9px' }}>{s}</span>
      ))}
    </div>
  )
}

function EducationBlock({ edu, lineH }: { edu: ResumeContent['education']; lineH: number }) {
  return (
    <>
      {edu.map((e, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, lineHeight: lineH }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{e.degree}</div>
            {e.institution && <div style={{ fontSize: 11, color: '#666' }}>{e.institution}</div>}
          </div>
          <div style={{ fontSize: 11, color: '#888', flexShrink: 0, marginLeft: 8 }}>{e.year}</div>
        </div>
      ))}
    </>
  )
}

function LangBlock({ langs }: { langs: NonNullable<ResumeContent['languages']> }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
      {langs.map((l, i) => (
        <span key={i} style={{ fontSize: 11, color: '#444' }}>
          <strong style={{ fontWeight: 600 }}>{l.lang}</strong>
          <span style={{ color: '#888', marginLeft: 4 }}>{l.level}</span>
        </span>
      ))}
    </div>
  )
}

function ProjectsBlock({ projects, accent, lineH }: { projects: NonNullable<ResumeContent['projects']>; accent: string; lineH: number }) {
  return (
    <>
      {projects.map((p, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
              {p.role && <span style={{ fontSize: 11, color: '#666', marginLeft: 6 }}>· {p.role}</span>}
              {p.url  && <span style={{ fontSize: 10, color: accent, marginLeft: 8 }}>{p.url}</span>}
            </div>
            <span style={{ fontSize: 10.5, color: '#888', flexShrink: 0, marginLeft: 8 }}>{p.period}</span>
          </div>
          <ul style={{ margin: '4px 0 0 14px', padding: 0 }}>
            {p.bullets.filter(Boolean).map((b, j) => (
              <li key={j} style={{ fontSize: 12, lineHeight: lineH, color: '#444', marginBottom: 2 }}>{b}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

function CertsBlock({ certs }: { certs: NonNullable<ResumeContent['certifications']> }) {
  return (
    <>
      {certs.map((c, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <div>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{c.name}</span>
            {c.issuer && <span style={{ fontSize: 11, color: '#666', marginLeft: 6 }}>· {c.issuer}</span>}
          </div>
          <span style={{ fontSize: 11, color: '#888', flexShrink: 0, marginLeft: 8 }}>{c.date}</span>
        </div>
      ))}
    </>
  )
}

function CustomBlocks({ customs, accent, lineH }: { customs: NonNullable<ResumeContent['custom']>; accent: string; lineH: number }) {
  return (
    <>
      {customs.map(entry => (
        <React.Fragment key={entry.id}>
          <SecTitle label={entry.title} accent={accent} />
          {entry.items.map((item, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              {(item.title || item.subtitle) && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <div>
                    {item.title    && <span style={{ fontSize: 12, fontWeight: 600 }}>{item.title}</span>}
                    {item.subtitle && <span style={{ fontSize: 11, color: '#666', marginLeft: 6 }}>· {item.subtitle}</span>}
                  </div>
                  <span style={{ fontSize: 11, color: '#888' }}>{item.period}</span>
                </div>
              )}
              <ul style={{ margin: '3px 0 0 14px', padding: 0 }}>
                {item.bullets.filter(Boolean).map((b, j) => (
                  <li key={j} style={{ fontSize: 12, lineHeight: lineH, color: '#444' }}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </React.Fragment>
      ))}
    </>
  )
}

// ── Section order helper ──────────────────────────────────────────────────────

function renderSections(
  c: ResumeContent,
  sectionOrder: string[],
  { accent, lineH, font, inline }: { accent: string; lineH: number; font: string; inline?: boolean },
) {
  const sections: React.ReactNode[] = []

  for (const id of sectionOrder) {
    if (id === 'summary' && c.summary) {
      sections.push(<React.Fragment key="summary"><SecTitle label="Summary" accent={accent} /><p style={{ fontSize: 12, lineHeight: lineH, color: '#444', margin: '0 0 4px' }}>{c.summary}</p></React.Fragment>)
    } else if (id === 'experience' && c.experience.length > 0) {
      sections.push(<React.Fragment key="experience"><SecTitle label="Experience" accent={accent} /><ExperienceBlock exp={c.experience} accent={accent} font={font} lineH={lineH} /></React.Fragment>)
    } else if (id === 'projects' && (c.projects?.length ?? 0) > 0) {
      sections.push(<React.Fragment key="projects"><SecTitle label="Projects" accent={accent} /><ProjectsBlock projects={c.projects!} accent={accent} lineH={lineH} /></React.Fragment>)
    } else if (id === 'skills' && c.skills.length > 0) {
      sections.push(<React.Fragment key="skills"><SecTitle label="Skills" accent={accent} /><SkillsBlock skills={c.skills} accent={accent} inline={inline} /></React.Fragment>)
    } else if (id === 'certifications' && (c.certifications?.length ?? 0) > 0) {
      sections.push(<React.Fragment key="certifications"><SecTitle label="Certifications" accent={accent} /><CertsBlock certs={c.certifications!} /></React.Fragment>)
    } else if (id === 'education' && c.education.length > 0) {
      sections.push(<React.Fragment key="education"><SecTitle label="Education" accent={accent} /><EducationBlock edu={c.education} lineH={lineH} /></React.Fragment>)
    } else if (id === 'languages' && (c.languages?.length ?? 0) > 0) {
      sections.push(<React.Fragment key="languages"><SecTitle label="Languages" accent={accent} /><LangBlock langs={c.languages!} /></React.Fragment>)
    } else if (id.startsWith('custom_')) {
      const entry = c.custom?.find(x => x.id === id)
      if (entry) sections.push(<CustomBlocks key={id} customs={[entry]} accent={accent} lineH={lineH} />)
    }
  }
  return sections
}

// ── DEFAULT SECTION ORDER for render (when sectionOrder not stored) ──────────
const DEFAULT_ORDER = ['summary','experience','projects','skills','certifications','education','languages']
function effectiveOrder(c: ResumeContent) {
  const base = c.sectionOrder ?? DEFAULT_ORDER
  // ensure any custom sections in custom array but not in order are appended
  const customs = (c.custom ?? []).map(x => x.id).filter(id => !base.includes(id))
  return [...base, ...customs]
}

// ── TEMPLATES ─────────────────────────────────────────────────────────────────

function TemplateClean({ c, opts }: { c: ResumeContent; opts?: TemplateOptions | null }) {
  const { accent, font, den } = resolveOpts(opts)
  const order = effectiveOrder(c)
  return (
    <div style={{ fontFamily: font, padding: den.pagePad, background: '#fff', minHeight: '100%' }}>
      {/* Header */}
      <div style={{ marginBottom: den.secGap, borderBottom: `3px solid ${accent}`, paddingBottom: 14 }}>
        <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px', color: '#1a1a1a', marginBottom: 4 }}>
          {c.contact.name || 'Your Name'}
        </div>
        <ContactLine c={c.contact} />
      </div>
      {/* Sections */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: den.secGap }}>
        {renderSections(c, order, { accent, lineH: den.lineH, font })}
      </div>
    </div>
  )
}

function TemplateExecutive({ c, opts }: { c: ResumeContent; opts?: TemplateOptions | null }) {
  const { accent, font, den } = resolveOpts(opts)
  const order = effectiveOrder(c)
  const [padV, padH] = den.pagePad.split(' ')
  const headerPadV = `${parseInt(padV) + 8}px`
  return (
    <div style={{ fontFamily: font, background: '#fff', minHeight: '100%' }}>
      {/* Bold header block */}
      <div style={{ background: accent, paddingTop: headerPadV, paddingRight: padH, paddingBottom: 24, paddingLeft: padH }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: '#fff', letterSpacing: '-0.5px', marginBottom: 6 }}>
          {c.contact.name || 'Your Name'}
        </div>
        {c.experience[0] && (
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', marginBottom: 10 }}>
            {c.experience[0].role}{c.experience[0].company ? ` · ${c.experience[0].company}` : ''}
          </div>
        )}
        <ContactLine c={c.contact} color="rgba(255,255,255,0.8)" />
      </div>
      {/* Body */}
      <div style={{ padding: `${den.secGap}px ${padH}`, display: 'flex', flexDirection: 'column', gap: den.secGap }}>
        {renderSections(c, order, { accent, lineH: den.lineH, font })}
      </div>
    </div>
  )
}

function TemplateSidebar({ c, opts }: { c: ResumeContent; opts?: TemplateOptions | null }) {
  const { accent, font, den } = resolveOpts(opts)
  const [padV, padH] = den.pagePad.split(' ')
  const mainOrder = (c.sectionOrder ?? DEFAULT_ORDER).filter(id => !['skills','education','languages'].includes(id))

  return (
    <div style={{ fontFamily: font, display: 'grid', gridTemplateColumns: '200px 1fr', background: '#fff', minHeight: '100%' }}>
      {/* Sidebar */}
      <div style={{ background: accent, padding: `${padV} 20px`, color: '#fff', minHeight: '100%' }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{c.contact.name || 'Your Name'}</div>
        {c.experience[0] && (
          <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.7)', marginBottom: 16 }}>{c.experience[0].role}</div>
        )}
        {/* Contact in sidebar */}
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.55)', borderBottom: '1px solid rgba(255,255,255,0.2)', paddingBottom: 3, marginBottom: 8 }}>CONTACT</div>
        <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.85)', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
          {c.contact.email    && <span>{c.contact.email}</span>}
          {c.contact.phone    && <span>{c.contact.phone}</span>}
          {c.contact.location && <span>{c.contact.location}</span>}
          {c.contact.linkedin && <span>LinkedIn</span>}
        </div>
        {/* Skills in sidebar */}
        {c.skills.length > 0 && (
          <>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.55)', borderBottom: '1px solid rgba(255,255,255,0.2)', paddingBottom: 3, marginBottom: 8 }}>SKILLS</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 16 }}>
              {c.skills.map(s => (
                <span key={s} style={{ fontSize: 10, background: 'rgba(255,255,255,0.15)', borderRadius: 3, padding: '2px 7px', color: '#fff' }}>{s}</span>
              ))}
            </div>
          </>
        )}
        {/* Education in sidebar */}
        {c.education.length > 0 && (
          <>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.55)', borderBottom: '1px solid rgba(255,255,255,0.2)', paddingBottom: 3, marginBottom: 8 }}>EDUCATION</div>
            {c.education.map((e, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#fff' }}>{e.degree}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)' }}>{e.institution}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>{e.year}</div>
              </div>
            ))}
          </>
        )}
        {/* Languages in sidebar */}
        {(c.languages?.length ?? 0) > 0 && (
          <>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.55)', borderBottom: '1px solid rgba(255,255,255,0.2)', paddingBottom: 3, marginBottom: 8 }}>LANGUAGES</div>
            {c.languages!.map((l, i) => (
              <div key={i} style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.85)', marginBottom: 3 }}>
                <strong>{l.lang}</strong><span style={{ opacity: 0.6, marginLeft: 4 }}>{l.level}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Main */}
      <div style={{ padding: `${padV} ${padH}`, display: 'flex', flexDirection: 'column', gap: den.secGap }}>
        {renderSections(c, mainOrder, { accent, lineH: den.lineH, font })}
      </div>
    </div>
  )
}

function TemplateTimeline({ c, opts }: { c: ResumeContent; opts?: TemplateOptions | null }) {
  const { accent, font, den } = resolveOpts(opts)
  const order = effectiveOrder(c)
  return (
    <div style={{ fontFamily: font, padding: den.pagePad, background: '#fff', minHeight: '100%' }}>
      {/* Name line with left accent bar */}
      <div style={{ display: 'flex', gap: 16, marginBottom: den.secGap, alignItems: 'flex-start' }}>
        <div style={{ width: 5, background: accent, borderRadius: 3, alignSelf: 'stretch', flexShrink: 0, minHeight: 40 }} />
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#1a1a1a', letterSpacing: '-0.5px', marginBottom: 5 }}>
            {c.contact.name || 'Your Name'}
          </div>
          <ContactLine c={c.contact} />
        </div>
      </div>

      {/* Sections with timeline line */}
      {order.map((id, i) => {
        const nodes: React.ReactNode[] = renderSections(c, [id], { accent, lineH: den.lineH, font }) as React.ReactNode[]
        if (!nodes[0]) return null
        return (
          <div key={id} style={{ display: 'flex', gap: 16, marginBottom: den.secGap }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', background: accent, marginTop: 2, flexShrink: 0 }} />
              <div style={{ width: 1, flex: 1, background: `${accent}30`, marginTop: 4 }} />
            </div>
            <div style={{ flex: 1, paddingBottom: 8 }}>{nodes[0]}</div>
          </div>
        )
      })}
    </div>
  )
}

function TemplateCompact({ c, opts }: { c: ResumeContent; opts?: TemplateOptions | null }) {
  const { accent, font, den } = resolveOpts(opts)
  const order = effectiveOrder(c)
  const smallPad = '24px 36px'
  return (
    <div style={{ fontFamily: "'Arial', 'Helvetica', sans-serif", padding: smallPad, background: '#fff', minHeight: '100%', fontSize: 11 }}>
      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 2 }}>{c.contact.name || 'Your Name'}</div>
      <div style={{ borderTop: `2px solid ${accent}`, margin: '5px 0 5px' }} />
      <div style={{ fontSize: 10, color: '#555', marginBottom: 12 }}>
        {[c.contact.email, c.contact.phone, c.contact.location, c.contact.linkedin && 'LinkedIn', c.contact.github && 'GitHub'].filter(Boolean).join(' · ')}
      </div>
      {order.map(id => {
        const nodes = renderSections(c, [id], { accent, lineH: 1.5, font, inline: true }) as React.ReactNode[]
        if (!nodes[0]) return null
        return <div key={id} style={{ marginBottom: 10 }}>{nodes[0]}</div>
      })}
    </div>
  )
}

// ── Main renderer ─────────────────────────────────────────────────────────────

export function ResumeRenderer({ content, templateId, templateOptions, scale }: {
  content:          ResumeContent
  templateId?:      string | null
  templateOptions?: TemplateOptions | null
  scale?:           number
}) {
  const template = templateId ?? 'clean'
  const style: React.CSSProperties = scale
    ? { transform: `scale(${scale})`, transformOrigin: 'top left', width: `${100 / scale}%` }
    : {}

  const props = { c: content, opts: templateOptions }

  let node: React.ReactNode
  switch (template) {
    case 'executive': node = <TemplateExecutive {...props} />; break
    case 'sidebar':   node = <TemplateSidebar   {...props} />; break
    case 'timeline':  node = <TemplateTimeline  {...props} />; break
    case 'compact':   node = <TemplateCompact   {...props} />; break
    default:          node = <TemplateClean     {...props} />; break
  }

  return <div style={style}>{node}</div>
}
