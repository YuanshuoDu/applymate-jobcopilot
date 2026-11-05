import type { CoverLetter } from './types'

type MaterialSelection = {
  jobId: string
  resumeId: string
  finalResumeId: string | null
  finalCoverLetterId: string | null
}

/** Reuse a bound letter or an explicitly saved edit; never select a draft implicitly. */
export function selectApplicationCoverLetter(selection: MaterialSelection, letters: CoverLetter[], edited: CoverLetter | null = null): CoverLetter | null {
  const matches = (letter: CoverLetter) => letter.jobId === selection.jobId
    && (letter.resumeId === selection.resumeId || letter.resumeId === null)
  if (edited && matches(edited)) return edited
  return letters.find(letter => letter.id === selection.finalCoverLetterId && matches(letter)) ?? null
}

/** Assigning an unchanged letter still updates its revision; omit that no-op. */
export function applicationMaterialAssignment(resumeId: string, coverLetterId: string | null, currentCoverLetterId: string | null): {
  finalResumeId: string
  finalCoverLetterId?: string | null
} {
  return {
    finalResumeId: resumeId,
    ...(coverLetterId !== currentCoverLetterId ? { finalCoverLetterId: coverLetterId } : {}),
  }
}
