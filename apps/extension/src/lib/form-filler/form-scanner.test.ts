import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyElement, scanIframes } from './form-scanner'

afterEach(() => vi.unstubAllGlobals())

function sharedFormFixture() {
  const secretNode = {
    nodeType: 1,
    closest: () => secretNode,
    get childNodes() { throw new Error('OTP value subtree was read') },
  }
  const label = {
    closest: () => null,
    childNodes: [{ nodeType: 3, nodeValue: 'First name' }, secretNode],
    get textContent() { throw new Error('Mixed label text was read') },
  }
  const fieldset = {
    get textContent() { throw new Error('Shared fieldset with OTP was read') },
  }
  const attributes: Record<string, string> = { id: 'first-name', name: 'first_name', type: 'text' }
  const input = {
    tagName: 'INPUT', value: 'Candidate',
    getAttribute: (key: string) => attributes[key] ?? null,
    closest: (selector: string) => selector === '[required]' ? null : fieldset,
  } as unknown as HTMLElement
  const doc = {
    querySelector: () => label,
    querySelectorAll: () => [input],
  } as unknown as Document
  vi.stubGlobal('CSS', { escape: (text: string) => text })
  vi.stubGlobal('document', doc)
  return { input, doc }
}

describe('fallback form context safety', () => {
  it('keeps a normal field without collecting an OTP from its label or shared container', () => {
    const { input } = sharedFormFixture()
    const field = classifyElement(input)
    expect(field).toMatchObject({ label: 'First name', currentValue: 'Candidate', surroundingText: '' })
    expect(field?.id).toMatch(/^n-/)
  })

  it('applies the same context boundary to same-origin iframe fields', () => {
    const { doc } = sharedFormFixture()
    vi.stubGlobal('document', {
      querySelector: () => doc.querySelector('label'),
      querySelectorAll: () => [{ contentDocument: doc, src: 'https://jobs.example/apply' }],
    })
    const fields = scanIframes([])
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ label: 'First name', currentValue: 'Candidate', surroundingText: '' })
    expect(fields[0].id).toMatch(/^iframe\|/)
  })
})
