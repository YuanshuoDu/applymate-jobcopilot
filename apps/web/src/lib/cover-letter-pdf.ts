// apps/web/src/lib/cover-letter-pdf.ts
import type { CoverLetterDocProps } from '@/components/resume/templates/cover-letter/CoverLetterFrame'
import type { TemplateOptions } from '@/lib/types'

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
  const variant: CoverLetterDocProps['templateVariant'] =
    resumeTemplateId === 'executive' || resumeTemplateId === 'sidebar'
      ? 'classic'
      : resumeTemplateId === 'compact'
        ? 'minimal'
        : 'modern'

  // CSS variables work in the HTML preview but are not valid color values for
  // @react-pdf/renderer. Fall back to the product's exported blue instead.
  const accentColor = resumeOptions?.accentColor?.startsWith('var(')
    ? '#185FA5'
    : resumeOptions?.accentColor ?? '#185FA5'

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

  if (variant === 'classic') {
    const { ClassicCoverLetter } = await import('@/components/resume/templates/cover-letter/ClassicCoverLetter')
    const React = (await import('react')).default
    return React.createElement(ClassicCoverLetter, props)
  }
  if (variant === 'minimal') {
    const { MinimalCoverLetter } = await import('@/components/resume/templates/cover-letter/MinimalCoverLetter')
    const React = (await import('react')).default
    return React.createElement(MinimalCoverLetter, props)
  }
  // default: modern
  const { ModernCoverLetter } = await import('@/components/resume/templates/cover-letter/ModernCoverLetter')
  const React = (await import('react')).default
  return React.createElement(ModernCoverLetter, props)
}
