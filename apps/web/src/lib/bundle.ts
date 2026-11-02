// Every application-pack download goes through the server's ownership and audit gate.
export class BundleError extends Error {}

export async function downloadApplicationPack(jobId: string): Promise<{ filename: string }> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/application-pack`, { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string }
    throw new BundleError(error.error ?? 'Could not download the application pack')
  }
  if (!response.headers.get('Content-Type')?.includes('application/zip')) {
    throw new BundleError('The server did not return an application ZIP. Please sign in and try again.')
  }
  const encodedName = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  let filename = 'ApplyMate-application-pack.zip'
  try { if (encodedName) filename = decodeURIComponent(encodedName) } catch { /* use the safe fallback */ }
  filename = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 180)
  const blob = await response.blob()
  if (!blob.size) throw new BundleError('The application ZIP is empty. Please try again.')
  const { saveAs } = await import('file-saver')
  saveAs(blob, filename)
  return { filename }
}

/** Compatibility for older web callers, with the same server-side audit gate. */
export async function downloadJobBundle(jobId: string): Promise<void> {
  await downloadApplicationPack(jobId)
}
