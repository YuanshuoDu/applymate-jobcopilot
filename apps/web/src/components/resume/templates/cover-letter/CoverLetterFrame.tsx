// apps/web/src/components/resume/templates/cover-letter/CoverLetterFrame.tsx
import React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'

export interface CoverLetterDocProps {
  content:      string          // the letter body text
  accentColor?: string          // hex, e.g. 'var(--primary)'
  fontFamily?:  'serif' | 'sans' | 'mono'
  density?:     'compact' | 'comfortable' | 'spacious'
  applicant: {
    name:      string
    email?:    string
    phone?:    string
    location?: string
    linkedin?: string
  }
  recipient?: {
    company: string
    role:    string
  }
  date?: Date
  templateVariant: 'modern' | 'classic' | 'minimal'
}

// Font sizes and spacing per density
function getDensityScale(density?: string) {
  if (density === 'compact')    return { body: 9.5,  heading: 12, line: 1.4, margin: 28 }
  if (density === 'spacious')   return { body: 11,   heading: 14, line: 1.7, margin: 40 }
  return                               { body: 10,   heading: 13, line: 1.55, margin: 34 }  // comfortable
}

export function CoverLetterDoc({
  content,
  accentColor = 'var(--primary)',
  fontFamily = 'sans',
  density,
  applicant,
  recipient,
  date,
  templateVariant,
}: CoverLetterDocProps) {
  const d       = getDensityScale(density)
  const color   = accentColor
  const dateStr = date
    ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  const isModern  = templateVariant === 'modern'
  const isClassic = templateVariant === 'classic'
  const isMinimal = templateVariant === 'minimal'

  const pdfFontFamily = fontFamily === 'serif' ? 'Times-Roman' : 'Helvetica'
  const pdfFontBold   = fontFamily === 'serif' ? 'Times-Bold'  : 'Helvetica-Bold'

  const styles = StyleSheet.create({
    page: {
      padding:    d.margin,
      fontFamily: pdfFontFamily,
      fontSize:   d.body,
      lineHeight: d.line,
      color:      '#1a1a1a',
    },
    header: {
      marginBottom:      20,
      ...(isModern  ? { borderBottomWidth: 2,   borderBottomColor: color, paddingBottom: 10 } : {}),
      ...(isClassic ? { backgroundColor: '#f4f4f5', borderLeftWidth: 5, borderLeftColor: color, padding: 12 } : {}),
      ...(isMinimal ? { borderBottomWidth: 1, borderBottomColor: '#d4d4d8', paddingBottom: 6 } : {}),
    },
    name: {
      fontSize:   d.heading + 2,
      fontFamily: pdfFontBold,
      color:      isModern ? color : '#1a1a1a',
      marginBottom: 2,
    },
    contactLine: {
      fontSize:      d.body - 1.5,
      color:         '#555',
      flexDirection: 'row',
      flexWrap:      'wrap',
    },
    contactItem: {
      marginRight: 8,
    },
    date: {
      marginTop:    16,
      marginBottom: 8,
      fontSize:     d.body,
      color:        '#333',
    },
    recipient: {
      marginBottom: 16,
    },
    recipientName: {
      fontSize:   d.body,
      fontFamily: pdfFontBold,
    },
    recipientRole: {
      fontSize: d.body,
      color:    '#444',
    },
    body: {
      fontSize:   d.body,
      lineHeight: d.line,
      ...(isMinimal ? { color: '#333' } : {}),
    },
    signature: {
      marginTop: 20,
    },
    sigClosing: {
      fontSize:     d.body,
      color:        '#333',
      marginBottom: 4,
    },
    sigName: {
      fontFamily: pdfFontBold,
      fontSize:   d.body,
    },
  })

  const contactParts = [
    applicant.email,
    applicant.phone,
    applicant.location,
    applicant.linkedin,
  ].filter(Boolean) as string[]

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.name}>{applicant.name || 'Applicant'}</Text>
          {contactParts.length > 0 && (
            <View style={styles.contactLine}>
              {contactParts.map((p, i) => (
                <Text key={i} style={styles.contactItem}>{p}</Text>
              ))}
            </View>
          )}
        </View>

        {/* Date */}
        <Text style={styles.date}>{dateStr}</Text>

        {/* Recipient */}
        {recipient && (
          <View style={styles.recipient}>
            <Text style={styles.recipientName}>{recipient.company}</Text>
            <Text style={styles.recipientRole}>{recipient.role}</Text>
          </View>
        )}

        {/* Body */}
        <Text style={styles.body}>{content}</Text>

        {/* Signature */}
        <View style={styles.signature}>
          <Text style={styles.sigClosing}>Sincerely,</Text>
          <Text style={styles.sigName}>{applicant.name || 'Applicant'}</Text>
        </View>
      </Page>
    </Document>
  )
}
