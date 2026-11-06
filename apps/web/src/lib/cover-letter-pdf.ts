// apps/web/src/lib/cover-letter-pdf.ts
import type { CoverLetterDocProps } from '@/components/resume/templates/cover-letter/CoverLetterFrame'
import type { TemplateOptions } from '@/lib/types'
import { safeAccentColor } from '@/lib/template-options'
import { assertPdfTextSupported } from '@/lib/pdf-text-support'

/**
 * Select the right CL template based on resume templateId
 * and return a React element for @react-pdf/renderer's `pdf()` function.
 */
export async function renderCoverLetterDoc(
  clContent: string,
  resumeTemplateId: string | null | undefined,
  resumeOptions: TemplateOptions | null | undefined,
  applicant: CoverLetterDocProps['applicant'],
  recipient?: CoverLetterDocProps['recipient'],
): Promise<React.ReactElement> {
  for (const value of [clContent, applicant.name, applicant.email, applicant.phone, applicant.location, applicant.linkedin, recipient?.company, recipient?.role]) {
    if (value) assertPdfTextSupported(value)
  }
  const variant: CoverLetterDocProps['templateVariant'] =
    resumeTemplateId === 'executive' || resumeTemplateId === 'sidebar'
      ? 'classic'
      : resumeTemplateId === 'compact'
        ? 'minimal'
        : 'modern'

  // CSS variables work in the HTML preview but are not valid color values for
  // @react-pdf/renderer. Fall back to the product's exported blue instead.
  const accentColor = safeAccentColor(resumeOptions?.accentColor, '#185FA5')
    .startsWith('var(') ? '#185FA5' : safeAccentColor(resumeOptions?.accentColor, '#185FA5')

  const props: CoverLetterDocProps = {
    content:         clContent,
    accentColor,
    fontFamily:      resumeOptions?.fontFamily  ?? 'sans',
    density:         resumeOptions?.density     ?? 'comfortable',
    applicant,
    recipient,
    date:            new Date(),
    templateVariant: variant,
  }

  const [{ CoverLetterDoc }, { default: React }] = await Promise.all([
    import('@/components/resume/templates/cover-letter/CoverLetterFrame'), import('react'),
  ])
  return React.createElement(CoverLetterDoc, props)
}
