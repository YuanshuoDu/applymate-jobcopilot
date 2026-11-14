export function mayApplyApplicationAnalysis(snapshot: {
  mounted: boolean
  userId: string | null
  currentUserId: string | null
  resumeId: string | null
  currentResumeId: string | null
  jobId: string
  currentJobId: string | null
  revision: string | null
  currentRevision: string | null
  editRevision: number
  currentEditRevision: number
  epoch: number
  currentEpoch: number
}): boolean {
  return snapshot.mounted && !!snapshot.userId && snapshot.userId === snapshot.currentUserId
    && !!snapshot.resumeId && snapshot.resumeId === snapshot.currentResumeId
    && snapshot.jobId === snapshot.currentJobId && snapshot.revision === snapshot.currentRevision
    && snapshot.editRevision === snapshot.currentEditRevision && snapshot.epoch === snapshot.currentEpoch
}
