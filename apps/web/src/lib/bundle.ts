import { readApplicationExportSnapshot, sameApplicationExportSnapshot } from './application-export-snapshot'

export class BundleError extends Error {}
/** The audited endpoint rejected characters that its PDF renderer cannot represent. */
export class BundleUnsupportedPdfError extends BundleError {}
export type LocalApplicationPack = { folderPath: string; opened: boolean; resumeFile?: string; coverLetterFile?: string }

export async function exportApplicationPackLocally(jobId: string, openFolder = false): Promise<LocalApplicationPack> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/export-local`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openFolder, openOnly: openFolder }),
  })
  const data = await response.json().catch(() => ({})) as Partial<LocalApplicationPack> & { error?: string }
  if (!response.ok || !data.folderPath) throw new BundleError(data.error ?? 'Could not create the local application pack')
  return { folderPath: data.folderPath, opened: Boolean(data.opened) }
}

async function fetchApplicationPack(jobId: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/application-pack`, { method: 'POST' })
  if (!response.ok) {
    if (response.status === 422) throw new BundleUnsupportedPdfError('Some characters cannot be rendered. Use Print view / Save as PDF and check the preview before saving.')
    if (response.status === 409) throw new BundleError('Check the selected materials and audit before downloading.')
    throw new BundleError('Could not download the application pack')
  }
  if (!response.headers.get('Content-Type')?.includes('application/zip')) throw new BundleError('The server did not return an application ZIP. Please sign in and try again.')
  const encodedName = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8\'\'([^;]+)/i)?.[1]
  let filename = 'ApplyMate-application-pack.zip'
  try { if (encodedName) filename = decodeURIComponent(encodedName) } catch { /* use the safe fallback */ }
  filename = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 180)
  const blob = await response.blob()
  if (!blob.size) throw new BundleError('The application ZIP is empty. Please try again.')
  return { blob, filename }
}

async function savePack(pack: { blob: Blob; filename: string }): Promise<void> {
  const { default: saveAs } = await import('file-saver')
  saveAs(pack.blob, pack.filename)
}

/** All ZIP bytes are produced by the server-owned audit gate. */
export async function downloadApplicationPack(jobId: string): Promise<{ filename: string }> {
  const pack = await fetchApplicationPack(jobId)
  await savePack(pack)
  return { filename: pack.filename }
}

/** Preserve account and selected-material stability through download and before saving. */
export async function downloadAuditedApplicationBundle(jobId: string, userId: string, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) throw new BundleError('Application session changed. Please try again.')
  const snapshot = await readApplicationExportSnapshot(jobId, userId)
  if (!isCurrent()) throw new BundleError('Application session changed. Please try again.')
  const pack = await fetchApplicationPack(jobId)
  if (!isCurrent()) throw new BundleError('Application session changed. Please try again.')
  const latest = await readApplicationExportSnapshot(jobId, userId)
  if (!isCurrent() || !sameApplicationExportSnapshot(snapshot, latest)) throw new BundleError('Application materials changed. Check them again before downloading.')
  const { default: saveAs } = await import('file-saver')
  if (!isCurrent()) throw new BundleError('Application session changed. Please try again.')
  saveAs(pack.blob, pack.filename)
}

export async function downloadJobBundle(jobId: string): Promise<void> {
  await downloadApplicationPack(jobId)
}
