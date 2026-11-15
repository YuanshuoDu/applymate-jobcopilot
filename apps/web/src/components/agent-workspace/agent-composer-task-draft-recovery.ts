import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

export function takeDeferredTaskDraft(
  drafts: Map<string | null, string>, sessionId: string | null, composerInput: string, isReady: boolean,
): string | null {
  if (!isReady || composerInput.trim()) return null
  const draft = drafts.get(sessionId)
  if (draft === undefined) return null
  drafts.delete(sessionId)
  return draft
}

export function useTaskDraftRecovery(
  sessionId: string | null,
  composerSessionId: string | null,
  restoring: boolean,
  composerInput: string,
  composerRef: MutableRefObject<{ sessionId: string; chatInput: string; setChatInput: (value: string) => void } | null>,
  setChatInput: Dispatch<SetStateAction<string>>,
) {
  const drafts = useRef(new Map<string | null, string>())
  const preserve = useCallback((target: string | null, draft: string) => drafts.current.set(target, draft), [])
  useEffect(() => {
    if (restoring || sessionId !== composerSessionId || composerInput.trim()) return
    const frame = window.requestAnimationFrame(() => {
      const composer = composerRef.current
      if (sessionId && composer?.sessionId !== sessionId || !sessionId && composer) return
      const draft = takeDeferredTaskDraft(drafts.current, sessionId, composer?.chatInput ?? composerInput, true)
      if (draft === null) return
      if (composer) composer.setChatInput(draft)
      else setChatInput(draft)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [sessionId, composerSessionId, restoring, composerInput, composerRef, setChatInput])
  return preserve
}
