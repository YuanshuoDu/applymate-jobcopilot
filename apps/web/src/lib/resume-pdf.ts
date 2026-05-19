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
  const accent  = opts.accentColor ?? '#185FA5'
  const font    = opts.fontFamily === 'serif' ? 'Times-Roman' : 'Helvetica'
  const bold    = opts.fontFamily === 'serif' ? 'Times-Bold'  : 'Helvetica-Bold'
  const d       = getDensity(opts.density)

  const styles = StyleSheet.create({
    page:      { padding: d.margin, fontFamily: font, fontSize: d.body, color: '#1a1a1a', lineHeight: 1.45 },
    name:      { fontFamily: bold, fontSize: d.h3 + 4, color: accent, marginBottom: 2 },
    contact:   { fontSize: d.body - 1.5, color: '#555', marginBottom: 10, flexDirection: 'row', flexWrap: 'wrap' },
    contactSep:{ marginHorizontal: 4, color: '#bbb' },
    section:   { marginTop: d.gap + 4 },
    secTitle:  { fontFamily: bold, fontSize: d.h3, color: accent, marginBottom: 3, borderBottomWidth: 0.5, borderBottomColor: accent, paddingBottom: 2 },
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

      // Name
      React.createElement(Text, { style: styles.name }, c.contact?.name || 'Resume'),

      // Contact row
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

      // Education
      c.education && c.education.length > 0
        ? React.createElement(
            View,
            { style: styles.section },
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
