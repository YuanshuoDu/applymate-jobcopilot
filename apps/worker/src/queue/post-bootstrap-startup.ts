export type StartupClose = () => void | Promise<void>

/**
 * Owns resources created after canonical bootstrap and closes them once.
 * Startup failures must preserve the first error while still releasing every
 * resource that was created before the failure.
 */
export function createPostBootstrapStartupFence(
  resources: () => ReadonlyArray<StartupClose | undefined>,
): { close(): Promise<void> } {
  let closing: Promise<void> | null = null

  return {
    close(): Promise<void> {
      if (closing) return closing
      closing = closeResources(resources())
      return closing
    },
  }
}

async function closeResources(resources: ReadonlyArray<StartupClose | undefined>): Promise<void> {
  let firstError: unknown
  for (const close of resources) {
    if (!close) continue
    try {
      await close()
    } catch (error: unknown) {
      if (firstError === undefined) firstError = error
    }
  }
  if (firstError !== undefined) throw firstError
}
