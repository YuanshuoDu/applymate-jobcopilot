// apps/web/src/components/resume/templates/cover-letter/MinimalCoverLetter.tsx
import { CoverLetterDoc, type CoverLetterDocProps } from './CoverLetterFrame'

export function MinimalCoverLetter(props: Omit<CoverLetterDocProps, 'templateVariant'>) {
  return <CoverLetterDoc {...props} templateVariant="minimal" />
}
