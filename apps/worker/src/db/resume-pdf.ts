import PDFDocument from 'pdfkit'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ResumeContent {
  personalInfo?: {
    fullName?: string; email?: string; phone?: string
    location?: string; linkedinUrl?: string; summary?: string
  }
  summary?: string
  skills?: Array<{ name?: string } | string>
  experience?: Array<{
    title?: string; company?: string
    startDate?: string; endDate?: string; description?: string
  }>
  education?: Array<{
    school?: string; degree?: string; field?: string; graduationDate?: string
  }>
}

export async function generateResumePdf(
  userId: string,
  content: ResumeContent,
): Promise<string> {
  const outputPath = join(tmpdir(), `resume-${userId}-${Date.now()}.pdf`)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' })
    const stream = createWriteStream(outputPath)
    doc.pipe(stream)

    // Header — name + contact
    const info = content.personalInfo ?? {}
    if (info.fullName) {
      doc.fontSize(20).font('Helvetica-Bold').text(info.fullName, { align: 'center' })
    }
    const contact = [info.email, info.phone, info.location, info.linkedinUrl]
      .filter(Boolean).join('  |  ')
    if (contact) {
      doc.fontSize(9).font('Helvetica').text(contact, { align: 'center' })
    }
    doc.moveDown(0.5)

    // Summary
    const summary = content.summary ?? info.summary
    if (summary) {
      doc.fontSize(11).font('Helvetica-Bold').text('SUMMARY')
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke()
      doc.fontSize(10).font('Helvetica').text(summary)
      doc.moveDown(0.5)
    }

    // Experience
    if (content.experience?.length) {
      doc.fontSize(11).font('Helvetica-Bold').text('EXPERIENCE')
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke()
      for (const exp of content.experience) {
        const period = [exp.startDate, exp.endDate ?? 'Present'].filter(Boolean).join(' – ')
        doc.fontSize(10).font('Helvetica-Bold')
          .text(`${exp.title ?? ''}`, { continued: true })
          .font('Helvetica').text(`  ${exp.company ?? ''}`)
        if (period) doc.fontSize(9).fillColor('grey').text(period).fillColor('black')
        if (exp.description) doc.fontSize(10).text(exp.description)
        doc.moveDown(0.3)
      }
    }

    // Skills
    if (content.skills?.length) {
      doc.fontSize(11).font('Helvetica-Bold').text('SKILLS')
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke()
      const skillStr = content.skills
        .map(s => typeof s === 'string' ? s : s.name ?? '')
        .filter(Boolean).join(', ')
      doc.fontSize(10).font('Helvetica').text(skillStr)
      doc.moveDown(0.3)
    }

    // Education
    if (content.education?.length) {
      doc.fontSize(11).font('Helvetica-Bold').text('EDUCATION')
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke()
      for (const edu of content.education) {
        doc.fontSize(10).font('Helvetica-Bold')
          .text(`${edu.degree ?? ''} in ${edu.field ?? ''}`)
        doc.font('Helvetica').text(`${edu.school ?? ''}${edu.graduationDate ? '  (' + edu.graduationDate + ')' : ''}`)
        doc.moveDown(0.3)
      }
    }

    doc.end()
    stream.on('finish', () => resolve(outputPath))
    stream.on('error', reject)
  })
}

