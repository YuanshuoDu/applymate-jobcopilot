import { describe, expect, it, vi } from 'vitest'
import { guardApplicationTraversal } from './application-traversal-guard'

function traversal(key: string) {
  return Object.assign(new Event('navigate', { cancelable: true }), {
    navigationType: 'traverse', destination: { sameDocument: true, key },
  })
}

describe('browser traversal while editing', () => {
  it('cancels before navigation and only replays the latest choice after all edits save', async () => {
    let dirty = true
    let resolve!: (value: boolean) => void
    const pending = new Promise<boolean>(done => { resolve = done })
    const guard = { needsSave: () => dirty, save: () => pending, currentHref: () => '' }
    const traverseTo = vi.fn(() => ({ committed: Promise.resolve(), finished: Promise.resolve() }))
    let attempt = 0
    const first = traversal('first')
    const second = traversal('second')
    const run = (event: ReturnType<typeof traversal>) => guardApplicationTraversal(event, guard, { traverseTo }, () => ++attempt, value => value === attempt)
    run(first)
    run(second)
    expect(first.defaultPrevented).toBe(true)
    expect(second.defaultPrevented).toBe(true)
    expect(traverseTo).not.toHaveBeenCalled()
    dirty = false
    resolve(true)
    await pending
    expect(traverseTo).toHaveBeenCalledExactlyOnceWith('second')
  })

  it('leaves the browser at the original entry when saving fails or edits remain', async () => {
    let attempt = 0
    const traverseTo = vi.fn(() => ({ committed: Promise.resolve(), finished: Promise.resolve() }))
    for (const [saved, dirty] of [[false, true], [true, true]] as const) {
      const event = traversal('old')
      guardApplicationTraversal(event, { needsSave: () => dirty, save: async () => saved, currentHref: () => '' }, { traverseTo }, () => ++attempt, value => value === attempt)
      expect(event.defaultPrevented).toBe(true)
      await Promise.resolve()
    }
    expect(traverseTo).not.toHaveBeenCalled()
  })
})
