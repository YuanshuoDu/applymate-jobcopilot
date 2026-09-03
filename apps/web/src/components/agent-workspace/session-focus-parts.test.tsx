import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FocusTaskTree, focusQuestionOptions } from './session-focus-parts'

describe('session focus parts', () => {
  it('renders nested task rows and only valid question options', () => {
    const html = renderToStaticMarkup(<FocusTaskTree nodes={[{ task: { id: 'root', role: 'scout', taskType: 'search', status: 'running', goal: 'Find roles' }, orphaned: false, children: [{ task: { id: 'child', role: 'analyst', taskType: 'score', status: 'completed', goal: 'Score roles' }, orphaned: false, children: [] }] }]} />)
    expect(html).toContain('Find roles')
    expect(html).toContain('Score roles')
    expect(focusQuestionOptions([{ label: 'Yes', value: 'yes' }, { label: 'bad' }, null])).toEqual([{ label: 'Yes', value: 'yes' }])
  })
})
