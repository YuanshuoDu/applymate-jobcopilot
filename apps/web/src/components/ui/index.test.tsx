import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Btn } from './index'

describe('Btn', () => {
  it('uses a native disabled button when disabled', () => {
    const markup = renderToStaticMarkup(<Btn disabled>Unavailable</Btn>)

    expect(markup).toContain('disabled=""')
  })
})
