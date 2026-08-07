import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ useEffect: vi.fn() }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useEffect: mocks.useEffect }
})

import { AdminSecurityPage } from './AdminSecurityPage'

describe('AdminSecurityPage', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
    mocks.useEffect.mockClear()
  })

  it('subscribes its grant loader so approval capability changes trigger a reload', () => {
    renderToStaticMarkup(React.createElement(AdminSecurityPage, { canApprove: true }))

    expect(mocks.useEffect).toHaveBeenCalledWith(
      expect.any(Function),
      expect.arrayContaining([expect.any(Function)]),
    )
  })
})
