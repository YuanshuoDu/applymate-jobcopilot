import { describe, expect, it } from 'vitest'
import { validPersonalActivity, validPersonalUsage } from './settings-usage-validation'

const zero = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
const positive = { calls: 2, inputTokens: 100, outputTokens: 20, totalTokens: 120 }
const daily = Array.from({ length: 7 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 9, 22 + index)).toISOString().slice(0, 10),
  ...(index === 6 ? positive : zero),
}))
const valid = {
  ownerId: 'owner-1', days: 7, timezone: 'UTC', from: '2026-10-22T00:00:00.000Z', to: '2026-10-28T12:00:00.000Z',
  summary: positive, daily, models: [{ provider: 'provider', model: 'model', ...positive }],
}

describe('personal usage response validation', () => {
  it('accepts a consistent UTC window, including recorded zero days', () => {
    expect(validPersonalUsage(valid, 7, 'owner-1')).toBe(true)
    expect(validPersonalUsage({ ...valid, summary: zero, daily: daily.map(row => ({ ...row, ...zero })), models: [] }, 7, 'owner-1')).toBe(true)
  })

  it('rejects incomplete, malformed or wrong-window data without inventing zero', () => {
    for (const value of [
      null, {}, { ...valid, ownerId: 'other-user' }, { ...valid, days: 30 }, { ...valid, timezone: 'local' }, { ...valid, from: 'no date' },
      { ...valid, to: '2026-02-30T12:00:00.000Z' }, { ...valid, to: '2026-10-28T24:00:00.000Z' }, { ...valid, from: '2026-10-21T00:00:00.000Z' },
      { ...valid, daily: [] }, { ...valid, daily: [...daily.slice(0, 6), { ...daily[6], date: '2026-02-30' }] },
      { ...valid, models: [{ ...valid.models[0], model: '' }] }, { ...valid, models: [valid.models[0], valid.models[0]] },
      { ...valid, summary: { ...positive, totalTokens: 119 } }, { ...valid, summary: { ...positive, calls: -1 } },
      { ...valid, summary: { ...positive, calls: 1.5 } }, { ...valid, summary: { ...positive, calls: Number.MAX_SAFE_INTEGER + 1 } },
      { ...valid, daily: daily.map(row => ({ ...row, ...zero })) }, { ...valid, models: [] },
    ]) expect(validPersonalUsage(value, 7, 'owner-1')).toBe(false)
  })
})

describe('personal activity response validation', () => {
  const row = { id: 'one', text: 'Original <script> text', createdAt: '2026-10-28T10:00:00.000Z' }
  it('retains original activity text and permits an empty, successfully loaded list', () => {
    expect(validPersonalActivity({ ownerId: 'owner-1', items: [] }, 'owner-1')).toBe(true)
    expect(validPersonalActivity({ ownerId: 'owner-1', items: [row] }, 'owner-1')).toBe(true)
  })
  it('rejects invalid dates, duplicates, missing fields and oversized results', () => {
    for (const value of [
      null, {}, [null], [{ ...row, createdAt: 'not a date' }], [{ ...row, createdAt: '2026-02-30T10:00:00.000Z' }],
      [{ ...row, text: null }], [{ ...row, id: '' }], [row, row], Array.from({ length: 13 }, (_, i) => ({ ...row, id: String(i) })),
    ]) expect(validPersonalActivity({ ownerId: 'owner-1', items: value }, 'owner-1')).toBe(false)
    expect(validPersonalActivity({ ownerId: 'other-user', items: [row] }, 'owner-1')).toBe(false)
  })
})
