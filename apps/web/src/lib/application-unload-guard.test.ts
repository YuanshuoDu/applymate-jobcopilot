import { describe, expect, it, vi } from 'vitest'
import { guardApplicationUnload } from './application-unload-guard'

describe('application unload guard', () => {
  it('requests the browser prompt only for unsaved or in-flight edits', () => {
    const event = { preventDefault: vi.fn(), returnValue: undefined } as unknown as BeforeUnloadEvent
    guardApplicationUnload(event, false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.returnValue).toBeUndefined()
    guardApplicationUnload(event, true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.returnValue).toBe('')
  })
})
