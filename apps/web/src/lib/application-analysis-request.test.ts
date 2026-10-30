import { describe, expect, it, vi } from 'vitest'
import { createApplicationAnalysisRequestPool } from './application-analysis-request'

describe('concurrent application analysis', () => {
  it('shares an in-flight target and version but starts a separate request for another version', async () => {
    const request = createApplicationAnalysisRequestPool<string>()
    let finish!: (value: string) => void
    const start = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const first = request('resume-a:job-a:version-1', start)
    request('resume-b:job-a:version-1', () => Promise.resolve('b'))
    const returning = request('resume-a:job-a:version-1', start)
    expect(returning).toBe(first)
    expect(start).toHaveBeenCalledOnce()
    expect(await request('resume-a:job-a:version-2', () => Promise.resolve('new'))).toBe('new')
    expect(await request('resume-a:job-a:version-1:edited', () => Promise.resolve('edited'))).toBe('edited')
    finish('original')
    expect(await returning).toBe('original')
    expect(await request('resume-a:job-a:version-1', () => Promise.resolve('retry'))).toBe('retry')
  })

  it('reuses completed successful work in memory, without retaining failures or invalidated requests', async () => {
    const request = createApplicationAnalysisRequestPool<string>(value => value !== 'failure')
    const start = vi.fn(async () => 'complete')
    expect(await request('a:v1', start)).toBe('complete')
    expect(await request('a:v1', start)).toBe('complete')
    expect(start).toHaveBeenCalledOnce()
    expect(await request('b:v1', async () => 'failure')).toBe('failure')
    expect(await request('b:v1', async () => 'retry')).toBe('retry')
    let finish!: (value: string) => void
    const old = request('c:v1', () => new Promise(resolve => { finish = resolve }))
    request.forget('c:v1')
    finish('old')
    await old
    expect(await request('c:v1', async () => 'new')).toBe('new')
    request.forget('a:v1')
    expect(await request('a:v1', async () => 'manual')).toBe('manual')
  })
})
