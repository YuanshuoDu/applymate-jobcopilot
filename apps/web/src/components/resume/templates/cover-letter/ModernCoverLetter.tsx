// apps/web/src/components/resume/templates/cover-letter/ModernCoverLetter.tsx
import { CoverLetterDoc, type CoverLetterDocProps } from './CoverLetterFrame'

export function ModernCoverLetter(props: Omit<CoverLetterDocProps, 'templateVariant'>) {
  return <CoverLetterDoc {...props} templateVariant="modern" />
}
