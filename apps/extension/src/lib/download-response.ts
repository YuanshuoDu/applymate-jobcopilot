/** Save a ZIP returned by the authenticated API using Chrome's normal downloads. */
export async function saveApplicationPackResponse(response: Response): Promise<{ filename: string }> {
  if (!response.headers.get('Content-Type')?.includes('application/zip')) {
    throw new Error('The server did not return an application ZIP. Please sign in and try again.')
  }
  const encodedName = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  let filename = 'ApplyMate-application-pack.zip'
  try { if (encodedName) filename = decodeURIComponent(encodedName) } catch { /* use the safe fallback */ }
  filename = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 180)
  const blob = await response.blob()
  if (!blob.size) throw new Error('The application ZIP is empty. Please try again.')
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // Leave the blob alive while Chrome starts the download.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return { filename }
}

/** Use the authenticated response so printing also works without a web session. */
export async function openApplicationPackPrintResponse(response: Response): Promise<void> {
  if (!response.headers.get('Content-Type')?.includes('text/html')) throw new Error('The server did not return a print view.')
  const blob = await response.blob()
  if (!blob.size) throw new Error('The application print view is empty.')
  const url = URL.createObjectURL(blob)
  try {
    await chrome.tabs.create({ url })
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}
