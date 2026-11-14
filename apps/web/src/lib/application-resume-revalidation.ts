export function mayApplyResumeRevalidation(snapshot: {
  resumeId: string
  currentResumeId: string | null
  userId: string | null
  currentUserId: string | null
  editRevision: number
  currentEditRevision: number
  saveGeneration: number
  currentSaveGeneration: number
  aborted: boolean
}): boolean {
  return !snapshot.aborted && !!snapshot.userId && snapshot.userId === snapshot.currentUserId
    && snapshot.resumeId === snapshot.currentResumeId
    && snapshot.editRevision === snapshot.currentEditRevision
    && snapshot.saveGeneration === snapshot.currentSaveGeneration
}
