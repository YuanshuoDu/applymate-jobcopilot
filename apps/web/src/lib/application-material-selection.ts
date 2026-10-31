import type { CoverLetter } from './types'

type MaterialSelection = {
  jobId: string
  resumeId: string
  finalResumeId: string | null
  finalCoverLetterId: string | null
}

/** A confirmed resume-only package must not silently acquire an unrelated draft. */
export function selectApplicationCoverLetter(selection: MaterialSelection, letters: CoverLetter[], edited: CoverLetter | null = null): CoverLetter | null {
  const matches = (letter: CoverLetter) => letter.jobId === selection.jobId
    && (letter.resumeId === selection.resumeId || letter.resumeId === null)
  if (edited && matches(edited)) return edited
  const matching = letters.filter(matches)
  if (selection.finalResumeId === selection.resumeId) {
    return matching.find(letter => letter.id === selection.finalCoverLetterId) ?? null
  }
  return matching.find(letter => letter.id === selection.finalCoverLetterId) ?? matching[0] ?? null
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
