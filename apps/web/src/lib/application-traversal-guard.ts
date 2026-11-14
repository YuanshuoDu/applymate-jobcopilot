import type { NavigationGuard } from './nav-context'

type TraversalEvent = Event & {
  navigationType: string
  destination: { sameDocument: boolean; key: string }
}
type Navigation = { traverseTo: (key: string) => { committed: Promise<unknown>; finished: Promise<unknown> } }

export function guardApplicationTraversal(
  event: TraversalEvent,
  guard: NavigationGuard | null,
  navigation: Navigation,
  nextAttempt: () => number,
  isLatest: (attempt: number) => boolean,
): void {
  if (event.navigationType !== 'traverse' || !event.destination.sameDocument || !event.cancelable || !guard?.needsSave()) return
  event.preventDefault()
  const attempt = nextAttempt()
  const key = event.destination.key
  void guard.save().then(saved => {
    if (!saved || guard.needsSave() || !isLatest(attempt)) return
    const traversal = navigation.traverseTo(key)
    void traversal.committed.catch(() => undefined)
    void traversal.finished.catch(() => undefined)
  }).catch(() => undefined)
}
