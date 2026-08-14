/**
 * Messaging helpers for content scripts that can outlive an extension update.
 * Chrome invalidates the old content-script context when the unpacked extension
 * is reloaded; callers should treat that state as a quiet no-op until refresh.
 */
export function isExtensionContextInvalidated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /extension context invalidated|receiving end does not exist/i.test(message)
}

export async function sendRuntimeMessage<T>(message: unknown): Promise<T | undefined> {
  try {
    if (!chrome.runtime?.id) return undefined
    return await chrome.runtime.sendMessage(message) as T | undefined
  } catch (error) {
    if (isExtensionContextInvalidated(error)) return undefined
    throw error
  }
}

