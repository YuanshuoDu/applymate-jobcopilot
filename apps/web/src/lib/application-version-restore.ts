export type VersionRestoreDisposition = 'ignore' | 'unknown' | 'conflict' | 'apply'

/** A restore response can only replace the editor it was requested for. */
export function versionRestoreDisposition(state: {
  mounted: boolean
  requestUserId: string
  currentUserId: string | null
  requestResumeId: string
  currentResumeId: string | null
  requestEditRevision: number
  currentEditRevision: number
  validResponse: boolean
}): VersionRestoreDisposition {
  if (!state.mounted || state.requestUserId !== state.currentUserId || state.requestResumeId !== state.currentResumeId) return 'ignore'
  if (!state.validResponse) return 'unknown'
  if (state.requestEditRevision !== state.currentEditRevision) return 'conflict'
  return 'apply'
}
