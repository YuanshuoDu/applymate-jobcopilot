// apps/web/src/lib/resume-pdf.ts
// M9: Full implementation — generates a React PDF document from resume data

import type { Resume, ResumeContent, TemplateOptions } from '@/lib/types'

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
  const accent  = opts.accentColor?.startsWith('var(') ? '#185FA5' : (opts.accentColor ?? '#185FA5')
  const font    = opts.fontFamily === 'serif' ? 'Times-Roman' : 'Helvetica'
  const bold    = opts.fontFamily === 'serif' ? 'Times-Bold'  : 'Helvetica-Bold'
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

  const c = content

  const contactItems = [
    c.contact?.email,
    c.contact?.phone,
    c.contact?.location,
    c.contact?.linkedin,
  ].filter(Boolean) as string[]

  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: 'A4', style: styles.page },

      React.createElement(
        View,
        { style: styles.header },
        React.createElement(Text, { style: styles.name }, c.contact?.name || 'Resume'),
        React.createElement(
          View,
          { style: styles.contact },
          ...contactItems.map((item, i) =>
            i === 0
              ? React.createElement(Text, { key: i }, item)
              : React.createElement(
                  React.Fragment,
                  { key: i },
                  React.createElement(Text, { style: styles.contactSep }, '·'),
                  React.createElement(Text, null, item),
                )
          )
        )
      ),

      // Summary
      c.summary
        ? React.createElement(
            View,
            { style: styles.section },
            React.createElement(Text, { style: styles.secTitle }, 'Summary'),
            React.createElement(Text, null, c.summary),
          )
        : null,

      // Experience
      c.experience && c.experience.length > 0
        ? React.createElement(
            View,
            { style: styles.section },
            React.createElement(Text, { style: styles.secTitle }, 'Experience'),
            ...c.experience.map((exp, i) =>
              React.createElement(
                View,
                { key: i, style: styles.expRow },
                React.createElement(
                  View,
                  { style: styles.expHead },
                  React.createElement(Text, { style: styles.expRole }, `${exp.role} — ${exp.company}`),
                  React.createElement(Text, { style: styles.expPeriod }, exp.period ?? ''),
                ),
                ...(exp.bullets ?? []).map((b, j) =>
                  React.createElement(Text, { key: j, style: styles.bullet }, `• ${b}`)
                ),
              )
            ),
          )
        : null,

      // Projects
      c.projects && c.projects.length > 0
        ? React.createElement(
            View,
            { style: styles.section },
            React.createElement(Text, { style: styles.secTitle }, 'Projects'),
            ...c.projects.map((project, i) =>
              React.createElement(
                View,
                { key: i, style: styles.expRow },
                React.createElement(
                  View,
                  { style: styles.expHead },
                  React.createElement(Text, { style: styles.expRole }, project.role ? `${project.name} — ${project.role}` : project.name),
                  React.createElement(Text, { style: styles.expPeriod }, project.period ?? ''),
                ),
                ...(project.bullets ?? []).map((bullet, j) => React.createElement(Text, { key: j, style: styles.bullet }, `• ${bullet}`)),
              )
            ),
          )
        : null,

      // Certifications
      c.certifications && c.certifications.length > 0
        ? React.createElement(
            View,
            { style: styles.section },
            React.createElement(Text, { style: styles.secTitle }, 'Certifications'),
            ...c.certifications.map((certification, i) => React.createElement(
              View,
              { key: i, style: styles.expHead },
              React.createElement(Text, { style: styles.expRole }, certification.issuer ? `${certification.name} — ${certification.issuer}` : certification.name),
              React.createElement(Text, { style: styles.expPeriod }, certification.date ?? ''),
            )),
          )
        : null,

      // Education
      c.education && c.education.length > 0
        ? React.createElement(
            View,
            // A long resume must never be visually clipped at the foot of page
            // one. Education starts a clean continuation page; subsequent
            // skills and language sections flow on the same page.
            { style: styles.section, break: true },
            React.createElement(Text, { style: styles.secTitle }, 'Education'),
            ...c.education.map((edu, i) =>
              React.createElement(
                View,
                { key: i, style: styles.expRow },
                React.createElement(
                  View,
                  { style: styles.expHead },
                  React.createElement(Text, { style: styles.expRole }, edu.degree ?? ''),
                  React.createElement(Text, { style: styles.expPeriod }, edu.year ?? ''),
                ),
                React.createElement(Text, { style: styles.eduSub }, edu.institution ?? ''),
              )
            ),
          )
        : null,

      // Skills
      c.skills && c.skills.length > 0
        ? React.createElement(
            View,
            { style: styles.section },
            React.createElement(Text, { style: styles.secTitle }, 'Skills'),
            React.createElement(
              View,
              { style: styles.skillRow },
              ...c.skills.map((s, i) =>
                React.createElement(
                  Text,
                  { key: i, style: styles.skill },
                  `${s}${i < c.skills!.length - 1 ? ' ·' : ''}`,
                )
              ),
            ),
          )
        : null,

      // Languages
      c.languages && c.languages.length > 0
        ? React.createElement(
            View,
            { style: styles.section },
            React.createElement(Text, { style: styles.secTitle }, 'Languages'),
            React.createElement(
              View,
              { style: styles.skillRow },
              ...c.languages.map((l, i) =>
                React.createElement(
                  Text,
                  { key: i, style: styles.skill },
                  `${l.lang}: ${l.level}${i < c.languages!.length - 1 ? ' ·' : ''}`,
                )
              ),
            ),
          )
        : null,
    ),
  )
}
