import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { detectFlow } from '../flows/index.js'
import { runGreenhouseFlow } from '../flows/greenhouse-flow.js'
import type { ApplyTask } from '../harness/agent-harness.js'

const SKIP = !process.env.RUN_INTEGRATION_TESTS

// ── Pure-logic tests (always run, no DB/Redis needed) ──────────────────
describe('detectFlow — URL routing', () => {
  it.each([
    ['https://boards.greenhouse.io/booking/jobs/123', 'greenhouse'],
    ['https://grnh.se/abc123', 'greenhouse'],
    ['https://sap.wd3.myworkdayjobs.com/SAP', 'workday'],
    ['https://jobs.lever.co/spotify', null],
    ['https://example.com/careers', null],
  ])('detectFlow(%s) → %s', (url, expected) => {
    expect(detectFlow(url)).toBe(expected)
  })
})

describe('Greenhouse dry-run (mocked page)', () => {
  it('returns dry-run status without calling page.fill', async () => {
    const fillMock = vi.fn()
    const page = {
      url: () => 'https://boards.greenhouse.io/test',
      title: () => Promise.resolve('Apply'),
      fill: fillMock,
      type: vi.fn(),
      locator: vi.fn().mockReturnValue({ first: () => ({ count: () => Promise.resolve(0), isVisible: () => Promise.resolve(false), click: vi.fn() }) }),
      evaluate: vi.fn().mockResolvedValue([]),
      waitForLoadState: vi.fn(),
    } as any

    const task: ApplyTask = {
      jobId: 'j1', applyUrl: 'https://boards.greenhouse.io/test',
      persona: { email: 'test@test.com' },
      jobTitle: 'Dev', jobCompany: 'Corp',
      resumePath: '/r.pdf', dryRun: true,
    }

    const result = await runGreenhouseFlow(page, task)
    expect(result.status).toBe('dry-run')
    expect(fillMock).not.toHaveBeenCalled()
  })
})

// ── Integration tests (require real DB + Redis) ────────────────────────
describe.skipIf(SKIP)('Integration — requires DATABASE_URL + REDIS_URL', () => {
  it('apply_results table is accessible', async () => {
    const { ensureApplyResultsTable, insertApplyResult, closePool } = await import('../db/apply-results.js')
    await ensureApplyResultsTable()
    const id = await insertApplyResult({
      userId: 'integration-test-user',
      jobId: 'integration-test-job',
      status: 'dry-run',
      mode: 'unattended',
      atsType: 'greenhouse',
      flowUsed: 'programmatic',
      durationMs: 100,
    })
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
    await closePool()
  })
})
