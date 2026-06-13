// apps/web/src/components/resume/templates/cover-letter/ClassicCoverLetter.tsx
import { CoverLetterDoc, type CoverLetterDocProps } from './CoverLetterFrame'

export function ClassicCoverLetter(props: Omit<CoverLetterDocProps, 'templateVariant'>) {
  return <CoverLetterDoc {...props} templateVariant="classic" />
}
