// apps/web/src/lib/resume-pdf.ts
// M9: Full implementation — generates a React PDF document from resume data

import type { Resume, ResumeContent, TemplateOptions } from '@/lib/types'
import { safeAccentColor } from '@/lib/template-options'
import { assertPdfTreeTextSupported } from '@/lib/pdf-text-support'

// Keep copied application text and URLs intact when lines wrap.
const noHyphenation = (word: string) => [word]

function getDensity(density?: string) {
  if (density === 'compact')  return { body: 9,  h3: 10.5, margin: 24, gap: 3 }
  if (density === 'spacious') return { body: 11, h3: 12.5, margin: 36, gap: 7 }
  return                             { body: 10, h3: 11.5, margin: 30, gap: 5 }
}

export async function renderResumeDoc(resume: Resume): Promise<React.ReactElement> {
  const React = (await import('react')).default
  const { Document, Page, Text, View, StyleSheet } = await import('@react-pdf/renderer')

  const content = resume.content as ResumeContent
  const opts    = (resume.templateOptions ?? {}) as TemplateOptions
  // CSS variables are valid in the browser preview but invalid in a PDF.
  // Convert the default preview token to the equivalent exported blue.
  const accent  = safeAccentColor(opts.accentColor, '#185FA5').startsWith('var(') ? '#185FA5' : safeAccentColor(opts.accentColor, '#185FA5')
  const font    = opts.fontFamily === 'serif' ? 'Times-Roman' : opts.fontFamily === 'mono' ? 'Courier' : 'Helvetica'
  const bold    = opts.fontFamily === 'serif' ? 'Times-Bold' : opts.fontFamily === 'mono' ? 'Courier-Bold' : 'Helvetica-Bold'
  const d       = getDensity(opts.density)
  const template = resume.templateId ?? 'clean'
  const executive = template === 'executive'
  const sidebar = template === 'sidebar'
  const timeline = template === 'timeline'
  const compact = template === 'compact'
  const pageMargin = compact ? 22 : d.margin

  const styles = StyleSheet.create({
    page:      { padding: pageMargin, fontFamily: font, fontSize: compact ? 8.8 : d.body, color: '#1a1a1a', lineHeight: compact ? 1.3 : 1.45 },
    header:    { marginHorizontal: sidebar ? -pageMargin : 0, marginTop: sidebar ? -pageMargin : 0, marginBottom: compact ? 8 : 14, padding: executive || sidebar ? pageMargin : 0, paddingBottom: executive || sidebar ? 16 : compact ? 7 : 10, backgroundColor: executive || sidebar ? accent : '#fff', borderBottomWidth: executive || sidebar ? 0 : compact ? 2 : 3, borderBottomColor: accent, borderLeftWidth: timeline ? 5 : 0, borderLeftColor: accent, paddingLeft: timeline ? 12 : executive || sidebar ? pageMargin : 0 },
    name:      { fontFamily: bold, fontSize: compact ? 17 : d.h3 + 5, color: executive || sidebar ? '#fff' : '#1a1a1a', marginBottom: 2 },
    contact:   { fontSize: compact ? 7.5 : d.body - 1.5, color: executive || sidebar ? '#eef6ff' : '#555', flexDirection: 'row', flexWrap: 'wrap' },
    contactSep:{ marginHorizontal: 4, color: '#bbb' },
    section:   { marginTop: compact ? 7 : d.gap + 4, borderLeftWidth: timeline ? 1 : 0, borderLeftColor: timeline ? `${accent}55` : '#fff', paddingLeft: timeline ? 10 : 0 },
    secTitle:  { fontFamily: bold, fontSize: compact ? 8.8 : d.h3, color: accent, marginBottom: 3, borderBottomWidth: compact ? 1 : 0.5, borderBottomColor: accent, paddingBottom: 2 },
    expRow:    { marginBottom: d.gap },
    expHead:   { flexDirection: 'row', justifyContent: 'space-between' },
    expRole:   { fontFamily: bold, fontSize: d.body },
    expPeriod: { fontSize: d.body - 1, color: '#666' },
    bullet:    { fontSize: d.body - 0.5, marginLeft: 8, marginTop: 1 },
    skill:     { fontSize: d.body - 0.5, marginRight: 8 },
    skillRow:  { flexDirection: 'row', flexWrap: 'wrap' },
    eduSub:    { fontSize: d.body - 0.5, color: '#555' },
  })

  const h = React.createElement
  const c = content
  const contactItems = [c.contact?.email, c.contact?.phone, c.contact?.location, c.contact?.linkedin, c.contact?.github, c.contact?.website]
    .filter(Boolean) as string[]

  function row(key: string, title: string, period?: string, subtitle?: string, bullets: string[] = [], url?: string) {
    return h(View, { key, style: styles.expRow },
      h(View, { style: styles.expHead },
        h(Text, { hyphenationCallback: noHyphenation, style: styles.expRole }, title),
        period ? h(Text, { hyphenationCallback: noHyphenation, style: styles.expPeriod }, period) : null,
      ),
      subtitle ? h(Text, { hyphenationCallback: noHyphenation, style: styles.eduSub }, subtitle) : null,
      url ? h(Text, { hyphenationCallback: noHyphenation, style: styles.eduSub }, url) : null,
      ...bullets.filter(Boolean).map((bullet, index) => h(Text, { hyphenationCallback: noHyphenation, key: index, style: styles.bullet }, `• ${bullet}`)),
    )
  }
  function section(id: string, title: string, children: React.ReactNode[]) {
    return children.length ? h(View, { key: id, style: styles.section },
      h(Text, { hyphenationCallback: noHyphenation, style: styles.secTitle, minPresenceAhead: 24 }, title), ...children,
    ) : null
  }
  const sections = new Map<string, React.ReactNode>([
    ['summary', c.summary ? section('summary', 'Summary', [h(Text, { hyphenationCallback: noHyphenation, key: 'text' }, c.summary)]) : null],
    ['experience', section('experience', 'Experience', (c.experience ?? []).map((item, index) =>
      row(String(index), [item.role, item.company].filter(Boolean).join(' — '), item.period, undefined, item.bullets)))],
    ['projects', section('projects', 'Projects', (c.projects ?? []).map((item, index) =>
      row(String(index), [item.name, item.role].filter(Boolean).join(' — '), item.period, undefined, item.bullets, item.url)))],
    ['certifications', section('certifications', 'Certifications', (c.certifications ?? []).map((item, index) =>
      row(String(index), item.name, item.date, item.issuer, [], item.url)))],
    ['education', section('education', 'Education', (c.education ?? []).map((item, index) =>
      row(String(index), item.degree, item.year, item.institution)))],
    ['skills', section('skills', 'Skills', (c.skills ?? []).length ? [h(Text, { hyphenationCallback: noHyphenation, key: 'skills' }, c.skills.join(' · '))] : [])],
    ['languages', section('languages', 'Languages', (c.languages ?? []).map((item, index) =>
      h(Text, { hyphenationCallback: noHyphenation, key: index }, `${item.lang}: ${item.level}`)))],
  ])
  for (const custom of c.custom ?? []) {
    sections.set(custom.id, section(custom.id, custom.title, custom.items.map((item, index) =>
      row(String(index), item.title ?? '', item.period, item.subtitle, item.bullets))))
  }
  const order = c.sectionOrder ?? ['summary', 'experience', 'projects', 'skills', 'certifications', 'education', 'languages']
  const customIds = (c.custom ?? []).map(custom => custom.id).filter(id => !order.includes(id))

  const document = h(Document, null, h(Page, { size: 'A4', style: styles.page },
    h(View, { style: styles.header },
      h(Text, { hyphenationCallback: noHyphenation, style: styles.name }, c.contact?.name || 'Resume'),
      h(Text, { hyphenationCallback: noHyphenation, style: styles.contact }, contactItems.join(' · ')),
    ),
    ...[...new Set([...order, ...customIds])].map(id => sections.get(id)),
  ))
  assertPdfTreeTextSupported(document)
  return document
}
