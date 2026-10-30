// Browser PDF renderer: the selected resume is rendered from its saved snapshot.
import type { Resume, TemplateOptions } from '@/lib/types'
import { safeAccentColor } from '@/lib/template-options'
import { applicationPdfSectionOrder } from './application-pdf-sections'
import { applicationPdfFontFamily, assertApplicationPdfTreeSupported, normalizeApplicationPdfTree, registerApplicationPdfFonts } from './application-pdf-font'

function getDensity(density?: string) {
  if (density === 'compact') return { body: 9, h3: 10.5, margin: 24, gap: 3 }
  if (density === 'spacious') return { body: 11, h3: 12.5, margin: 36, gap: 7 }
  return { body: 10, h3: 11.5, margin: 30, gap: 5 }
}

export async function renderResumeDoc(resume: Resume): Promise<React.ReactElement> {
  const React = (await import('react')).default
  const { Document, Page, Text, View, StyleSheet } = await import('@react-pdf/renderer')
  registerApplicationPdfFonts()
  const c = resume.content
  const opts = (resume.templateOptions ?? {}) as TemplateOptions
  const rawAccent = safeAccentColor(opts.accentColor, '#185FA5')
  const accent = rawAccent.startsWith('var(') ? '#185FA5' : rawAccent
  const font = applicationPdfFontFamily(opts.fontFamily === 'serif' ? 'Times-Roman' : opts.fontFamily === 'mono' ? 'Courier' : 'Helvetica')
  const bold = applicationPdfFontFamily(opts.fontFamily === 'serif' ? 'Times-Bold' : opts.fontFamily === 'mono' ? 'Courier-Bold' : 'Helvetica-Bold')
  const d = getDensity(opts.density)
  const template = resume.templateId ?? 'clean'
  const executive = template === 'executive', sidebar = template === 'sidebar', timeline = template === 'timeline', compact = template === 'compact'
  const pageMargin = compact ? 22 : d.margin
  const styles = StyleSheet.create({
    page: { padding: pageMargin, fontFamily: font, fontSize: compact ? 8.8 : d.body, color: '#1a1a1a', lineHeight: compact ? 1.3 : 1.45 },
    header: { marginHorizontal: sidebar ? -pageMargin : 0, marginTop: sidebar ? -pageMargin : 0, marginBottom: compact ? 8 : 14, padding: executive || sidebar ? pageMargin : 0, paddingBottom: executive || sidebar ? 16 : compact ? 7 : 10, backgroundColor: executive || sidebar ? accent : '#fff', borderBottomWidth: executive || sidebar ? 0 : compact ? 2 : 3, borderBottomColor: accent, borderLeftWidth: timeline ? 5 : 0, borderLeftColor: accent, paddingLeft: timeline ? 12 : executive || sidebar ? pageMargin : 0 },
    name: { fontFamily: bold, fontSize: compact ? 17 : d.h3 + 5, color: executive || sidebar ? '#fff' : '#1a1a1a', marginBottom: 2 },
    contact: { fontSize: compact ? 7.5 : d.body - 1.5, color: executive || sidebar ? '#eef6ff' : '#555', flexDirection: 'row', flexWrap: 'wrap' },
    section: { marginTop: compact ? 7 : d.gap + 4, borderLeftWidth: timeline ? 1 : 0, borderLeftColor: timeline ? `${accent}55` : '#fff', paddingLeft: timeline ? 10 : 0 },
    secTitle: { fontFamily: bold, fontSize: compact ? 8.8 : d.h3, color: accent, marginBottom: 3, borderBottomWidth: compact ? 1 : 0.5, borderBottomColor: accent, paddingBottom: 2 },
    row: { marginBottom: d.gap }, head: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
    role: { fontFamily: bold, fontSize: d.body, flexShrink: 1 }, period: { fontSize: d.body - 1, color: '#666' },
    bullet: { fontSize: d.body - 0.5, marginLeft: 8, marginTop: 1 }, sub: { fontSize: d.body - 0.5, color: '#555' },
  })
  const e = React.createElement
  const text = (value: string, key?: string | number) => e(Text, { key, style: styles.sub }, value)
  const bullets = (values: string[]) => values.filter(Boolean).map((value, i) => e(Text, { key: i, style: styles.bullet }, `• ${value}`))
  const head = (title: string, period?: string) => e(View, { style: styles.head }, e(Text, { style: styles.role }, title), e(Text, { style: styles.period }, period ?? ''))
  const section = (id: string, title: string, children: React.ReactNode[]) => e(View, { key: id, style: styles.section }, e(Text, { style: styles.secTitle }, title), ...children)
  const sections = applicationPdfSectionOrder(c).flatMap(id => {
    if (id === 'summary' && c.summary) return [section(id, 'Summary', [text(c.summary)])]
    if (id === 'experience' && c.experience?.length) return [section(id, 'Experience', c.experience.map((item, i) => e(View, { key: i, style: styles.row }, head([item.role, item.company].filter(Boolean).join(' — '), item.period), ...bullets(item.bullets ?? []))))]
    if (id === 'projects' && c.projects?.length) return [section(id, 'Projects', c.projects.map((item, i) => e(View, { key: i, style: styles.row }, head([item.name, item.role].filter(Boolean).join(' — '), item.period), ...(item.url ? [text(item.url)] : []), ...bullets(item.bullets ?? []))))]
    if (id === 'skills' && c.skills?.length) return [section(id, 'Skills', [text(c.skills.join(' · '))])]
    if (id === 'certifications' && c.certifications?.length) return [section(id, 'Certifications', c.certifications.map((item, i) => e(View, { key: i, style: styles.row }, head([item.name, item.issuer].filter(Boolean).join(' — '), item.date), ...(item.url ? [text(item.url)] : []))))]
    if (id === 'education' && c.education?.length) return [section(id, 'Education', c.education.map((item, i) => e(View, { key: i, style: styles.row }, head(item.degree ?? '', item.year), text(item.institution ?? ''))))]
    if (id === 'languages' && c.languages?.length) return [section(id, 'Languages', [text(c.languages.map(item => [item.lang, item.level].filter(Boolean).join(': ')).join(' · '))])]
    if (id.startsWith('custom_')) {
      const custom = c.custom?.find(item => item.id === id)
      if (custom) return [section(id, custom.title, custom.items.map((item, i) => e(View, { key: i, style: styles.row }, head([item.title, item.subtitle].filter(Boolean).join(' — '), item.period), ...bullets(item.bullets ?? []))))]
    }
    return []
  })
  const contact = [c.contact?.email, c.contact?.phone, c.contact?.location, c.contact?.linkedin, c.contact?.github, c.contact?.website].filter(Boolean) as string[]
  const document = normalizeApplicationPdfTree(e(Document, null, e(Page, { size: 'A4', style: styles.page },
    e(View, { style: styles.header }, e(Text, { style: styles.name }, c.contact?.name || 'Resume'), e(View, { style: styles.contact }, e(Text, null, contact.join(' · ')))),
    ...sections,
  ))) as React.ReactElement
  assertApplicationPdfTreeSupported(document)
  return document
}
