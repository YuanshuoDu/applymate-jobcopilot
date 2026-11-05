/** The public review fixture is the only production dashboard-origin job page. */
export function isPublicReviewJobPage(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return url.origin === 'https://applymate.site' && /^\/extension-review\/?$/.test(url.pathname)
  } catch { return false }
}
