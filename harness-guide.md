@codex Complete implementation guide for AgentHarness (#36). Follow this exactly.

## CRITICAL: Architecture Constraint

You CANNOT import from `apps/web`. `modelChat`/`loadUserAiConfig` use Prisma which lives in the web app. Solution:
- Add a minimal LLM caller to `packages/shared/src/llm.ts`
- Load user AI config via raw SQL using the `pg` Pool from `apps/worker/src/db/apply-results.ts`

---

## 5 Files to Create

```
packages/shared/src/llm.ts                      ← NEW
apps/worker/src/harness/dom-extractor.ts         ← NEW (≤150 lines)
apps/worker/src/harness/harness-prompt.ts        ← NEW (≤80 lines)
apps/worker/src/harness/agent-harness.ts         ← NEW (≤280 lines)
apps/worker/src/harness/agent-harness.test.ts    ← NEW (4 tests)
```

Also update `packages/shared/src/index.ts` to export the new LLM utilities.

---

## File 1: `packages/shared/src/llm.ts`

```typescript
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmConfig {
  provider: 'minimax' | 'openai' | 'anthropic' | 'openai-compat'
  model: string
  apiKey: string
  baseUrl?: string
}

export interface LlmResult {
  text: string
  inputTokens?: number
  outputTokens?: number
}

export async function callLlm(
  messages: LlmMessage[],
  config: LlmConfig,
  maxTokens = 1024,
): Promise<LlmResult> {
  if (config.provider === 'anthropic') return callAnthropic(messages, config, maxTokens)
  return callOpenAICompat(messages, config, maxTokens)
}

async function callOpenAICompat(
  messages: LlmMessage[],
  config: LlmConfig,
  maxTokens: number,
): Promise<LlmResult> {
  const baseUrl =
    config.baseUrl ??
    (config.provider === 'minimax'
      ? 'https://api.minimax.chat/v1'
      : 'https://api.openai.com/v1')

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    throw new Error(`LLM API error ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>
    usage?: { prompt_tokens: number; completion_tokens: number }
  }
  const raw = data.choices[0]?.message?.content ?? ''
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  return { text, inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens }
}

async function callAnthropic(
  messages: LlmMessage[],
  config: LlmConfig,
  maxTokens: number,
): Promise<LlmResult> {
  const systemMsg = messages.find(m => m.role === 'system')?.content ?? ''
  const chatMsgs = messages.filter(m => m.role !== 'system')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: config.model, system: systemMsg, messages: chatMsgs, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) throw new Error(`Anthropic error ${res.status}`)

  const data = await res.json() as {
    content: Array<{ type: string; text: string }>
    usage?: { input_tokens: number; output_tokens: number }
  }
  return {
    text: data.content.filter(b => b.type === 'text').map(b => b.text).join(''),
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  }
}

/**
 * Load the user's autoApply LLM config from Postgres using raw SQL.
 * Falls back to MiniMax M2.7 platform default if not configured.
 */
export async function loadWorkerAiConfig(
  userId: string,
  pool: import('pg').Pool,
): Promise<LlmConfig> {
  const platformDefault: LlmConfig = {
    provider: 'minimax',
    model: 'MiniMax-M2.7',
    apiKey: process.env.MINIMAX_API_KEY ?? '',
    baseUrl: 'https://api.minimax.chat/v1',
  }

  try {
    const res = await pool.query('SELECT preferences FROM "User" WHERE id = $1 LIMIT 1', [userId])
    const prefs = res.rows[0]?.preferences as Record<string, unknown> | null
    const aiSettings = prefs?.aiSettings as {
      features?: Record<string, { provider: string; model: string; apiKey?: string } | null>
      keys?: Record<string, string>
    } | null

    const featureCfg = aiSettings?.features?.['autoApply']
    if (!featureCfg) return platformDefault

    const provider = featureCfg.provider as LlmConfig['provider']
    const apiKey =
      featureCfg.apiKey?.trim() ||
      aiSettings?.keys?.[provider]?.trim() ||
      (provider === 'minimax' ? process.env.MINIMAX_API_KEY : undefined) ||
      (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined) ||
      (provider === 'openai' ? process.env.OPENAI_API_KEY : undefined) ||
      ''

    return { provider, model: featureCfg.model, apiKey }
  } catch {
    return platformDefault
  }
}
```

In `packages/shared/src/index.ts`, add:
```typescript
export type { LlmMessage, LlmConfig, LlmResult } from './llm.js'
export { callLlm, loadWorkerAiConfig } from './llm.js'
```

---

## File 2: `apps/worker/src/harness/harness-prompt.ts`

```typescript
import type { LlmMessage } from '@jobcopilot/shared'
import type { PerceivedField } from './dom-extractor.js'

export interface ApplyTask {
  jobId: string
  userId: string
  applyUrl: string
  personaId: string
  resumePath: string
  coverLetterPath?: string
  dryRun?: boolean
  // enriched before harness runs:
  jobTitle?: string
  jobCompany?: string
  jobKeywords?: string
  personaJson?: string
}

export interface AgentAction {
  type: 'fill' | 'click' | 'select' | 'upload' | 'scroll' | 'wait' | 'submit' | 'done' | 'manual'
  selector?: string
  value?: string
  filePath?: string
  waitMs?: number
  reasoning: string
}

export function buildMessages(
  task: ApplyTask,
  url: string,
  title: string,
  fields: PerceivedField[],
  turn: number,
): LlmMessage[] {
  const system = [
    'You are an autonomous job application agent for ApplyMate.',
    'Fill forms using ONLY the candidate data below. NEVER fabricate or invent information.',
    '',
    'CANDIDATE DATA:',
    task.personaJson ?? '{}',
    '',
    `JOB: ${task.jobTitle ?? 'Unknown'} at ${task.jobCompany ?? 'Unknown'}`,
    `KEY REQUIREMENTS: ${task.jobKeywords ?? 'not specified'}`,
    `RESUME PATH: ${task.resumePath}`,
    task.coverLetterPath ? `COVER LETTER PATH: ${task.coverLetterPath}` : '',
    '',
    'RULES:',
    '1. Fill ALL required fields visible on screen.',
    '2. For file upload fields: use resumePath or coverLetterPath above.',
    '3. For any data not in candidate profile: use empty string "".',
    '4. When all visible fields are filled: click Next or Submit.',
    '5. If you see CAPTCHA, login wall, or GDPR consent: return {"type":"manual","reasoning":"..."}',
    '6. Return ONLY valid JSON. No other text.',
    '',
    'AgentAction schema (return exactly this shape):',
    '{"type":"fill|click|select|upload|scroll|wait|submit|done|manual","selector":"css","value":"string","filePath":"path","waitMs":2000,"reasoning":"why"}',
  ].filter(Boolean).join('\n')

  const user = [
    `Turn ${turn}`,
    `URL: ${url}`,
    `Page title: ${title}`,
    '',
    `VISIBLE FORM FIELDS (${fields.length}):`,
    JSON.stringify(fields, null, 2),
    '',
    'What is the next action? Return JSON only:',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
```

---

## File 3: `apps/worker/src/harness/dom-extractor.ts`

This runs INSIDE the browser context via `page.evaluate()`. Adapted from `apps/extension/src/lib/form-filler/form-scanner.ts`.

```typescript
import type { Page } from 'playwright-core'

export interface PerceivedField {
  selector: string
  type: 'text' | 'email' | 'tel' | 'select' | 'checkbox' | 'radio' | 'file' | 'textarea' | 'url' | 'number'
  label: string
  required: boolean
  currentValue: string
  options?: string[]
}

/** Extract all interactable form fields from the current page. */
export async function extractFields(page: Page): Promise<PerceivedField[]> {
  // This function body runs in the browser context
  return page.evaluate((): Array<{
    selector: string; type: string; label: string
    required: boolean; currentValue: string; options?: string[]
  }> => {
    function getLabel(el: HTMLElement): string {
      const id = el.getAttribute('id')
      if (id) {
        const lbl = document.querySelector<HTMLLabelElement>('label[for="' + CSS.escape(id) + '"]')
        if (lbl) return (lbl.textContent ?? '').replace(/\s+/g, ' ').trim()
      }
      const parentLabel = el.closest('label')
      if (parentLabel) return (parentLabel.textContent ?? '').replace(/\s+/g, ' ').trim()
      const ariaLabel = el.getAttribute('aria-label')
      if (ariaLabel) return ariaLabel.trim()
      const labelledBy = el.getAttribute('aria-labelledby')
      if (labelledBy) {
        const lbl = document.getElementById(labelledBy.split(' ')[0])
        if (lbl) return (lbl.textContent ?? '').trim()
      }
      const ph = el.getAttribute('placeholder')
      if (ph && ph.length > 2) return ph.trim()
      const name = el.getAttribute('name')
      if (name) return name.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
      return ''
    }

    function getSelector(el: HTMLElement): string {
      if (el.id) return '#' + el.id
      const name = el.getAttribute('name')
      if (name) return '[name="' + name + '"]'
      const tag = el.tagName.toLowerCase()
      const idx = Array.from(document.querySelectorAll(tag)).indexOf(el as Element) + 1
      return tag + ':nth-of-type(' + idx + ')'
    }

    function getCurrentValue(el: HTMLElement): string {
      const inp = el as HTMLInputElement
      if (inp.type === 'checkbox' || inp.type === 'radio') return inp.checked ? (inp.value || 'true') : ''
      return inp.value ?? (el as HTMLTextAreaElement).value ?? ''
    }

    function getOptions(el: HTMLElement): string[] | undefined {
      if (el.tagName === 'SELECT') {
        return Array.from((el as HTMLSelectElement).options).map(o => o.text.trim()).filter(Boolean)
      }
      const name = el.getAttribute('name')
      const type = (el as HTMLInputElement).type
      if (type === 'radio' && name) {
        return Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="' + name + '"]')
        ).map(r => r.getAttribute('aria-label') || r.value || '').filter(Boolean)
      }
      return undefined
    }

    const seen = new Set<string>()
    const results: ReturnType<typeof extractFields> extends Promise<infer R> ? R : never = [] as any

    const elements = document.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),' +
      'textarea,select'
    )

    for (const el of elements) {
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue

      const selector = getSelector(el)
      if (seen.has(selector)) continue
      seen.add(selector)

      const tag = el.tagName.toLowerCase()
      const inputType = (el as HTMLInputElement).type?.toLowerCase() ?? ''

      let type: string = 'text'
      if (tag === 'textarea') type = 'textarea'
      else if (tag === 'select') type = 'select'
      else if (inputType === 'email') type = 'email'
      else if (inputType === 'tel' || inputType === 'phone') type = 'tel'
      else if (inputType === 'file') type = 'file'
      else if (inputType === 'checkbox') type = 'checkbox'
      else if (inputType === 'radio') type = 'radio'
      else if (inputType === 'url') type = 'url'
      else if (inputType === 'number') type = 'number'

      const label = getLabel(el)
      if (!label && type !== 'file') continue // skip unlabeled non-file fields

      const required =
        el.getAttribute('required') !== null ||
        el.getAttribute('aria-required') === 'true'

      results.push({
        selector,
        type,
        label: label || selector,
        required,
        currentValue: getCurrentValue(el),
        options: getOptions(el),
      })
    }

    return results
  }) as unknown as PerceivedField[]
}
```

---

## File 4: `apps/worker/src/harness/agent-harness.ts`

```typescript
import type { Page } from 'playwright-core'
import type { Pool } from 'pg'
import { callLlm, loadWorkerAiConfig } from '@jobcopilot/shared'
import { extractFields, type PerceivedField } from './dom-extractor.js'
import { buildMessages, type ApplyTask, type AgentAction } from './harness-prompt.js'

export type { ApplyTask, AgentAction }

export interface HarnessConfig {
  userId: string
  maxTurns: number       // default 30
  dryRun: boolean
  mode: 'dom' | 'vision' | 'hybrid'
  dbPool: Pool
}

export interface HarnessResult {
  status: 'submitted' | 'manual' | 'failed' | 'dry-run'
  turns: number
  error?: string
  log: TurnLog[]
}

interface TurnLog {
  turn: number
  url: string
  perceived: number
  action: AgentAction
  durationMs: number
}

const CONFIRMATION_KEYWORDS = ['thank', 'success', 'confirmation', 'submitted', 'application received']

export class AgentHarness {
  constructor(private readonly config: HarnessConfig) {}

  async run(page: Page, task: ApplyTask): Promise<HarnessResult> {
    const aiConfig = await loadWorkerAiConfig(this.config.userId, this.config.dbPool)
    const log: TurnLog[] = []

    for (let turn = 1; turn <= this.config.maxTurns; turn++) {
      const turnStart = Date.now()
      const url = page.url()
      const title = await page.title().catch(() => '')

      // Check for confirmation page
      const lc = (url + ' ' + title).toLowerCase()
      if (CONFIRMATION_KEYWORDS.some(kw => lc.includes(kw))) {
        console.log(JSON.stringify({ event: 'confirmation', url, turn }))
        return { status: 'submitted', turns: turn, log }
      }

      // Perceive
      let fields: PerceivedField[] = []
      try { fields = await extractFields(page) } catch { /* best-effort */ }

      // Decide
      const messages = buildMessages(task, url, title, fields, turn)
      let rawText = ''
      try {
        const result = await callLlm(messages, aiConfig, 512)
        rawText = result.text
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        return { status: 'failed', turns: turn, error, log }
      }

      // Parse AgentAction
      let action: AgentAction
      try {
        const match = rawText.match(/\{[\s\S]*\}/)
        action = JSON.parse(match?.[0] ?? rawText) as AgentAction
        if (!action?.type) throw new Error('missing type')
      } catch {
        action = { type: 'manual', reasoning: `LLM parse error: ${rawText.slice(0, 100)}` }
      }

      const durationMs = Date.now() - turnStart
      log.push({ turn, url, perceived: fields.length, action, durationMs })
      console.log(JSON.stringify({ turn, perceived: fields.length, action, durationMs }))

      // Terminal conditions
      if (action.type === 'done') return { status: 'submitted', turns: turn, log }
      if (action.type === 'manual') return { status: 'manual', turns: turn, error: action.reasoning, log }

      // Execute action
      try {
        await this.execute(page, action, task)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        return { status: 'failed', turns: turn, error, log }
      }

      // Brief settle time between turns
      await page.waitForTimeout(300 + Math.random() * 200).catch(() => {})
    }

    return {
      status: 'failed',
      turns: this.config.maxTurns,
      error: `maxTurns (${this.config.maxTurns}) reached without completion`,
      log,
    }
  }

  private async execute(page: Page, action: AgentAction, task: ApplyTask): Promise<void> {
    // Dry-run: log write actions without executing them
    if (this.config.dryRun && ['fill', 'click', 'select', 'upload', 'submit'].includes(action.type)) {
      console.log(JSON.stringify({ event: 'dry_run_skip', type: action.type, selector: action.selector }))
      return
    }

    switch (action.type) {
      case 'fill': {
        if (!action.selector || action.value == null) return
        await page.click(action.selector).catch(() => {})
        await page.fill(action.selector, '')
        // Human-speed typing: 50-120ms per character
        for (const ch of action.value) {
          await page.type(action.selector, ch, { delay: 50 + Math.random() * 70 })
        }
        break
      }
      case 'click': {
        if (!action.selector) return
        await page.click(action.selector)
        await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
        break
      }
      case 'select': {
        if (!action.selector || !action.value) return
        await page.selectOption(action.selector, action.value)
        break
      }
      case 'upload': {
        if (!action.selector) return
        const filePath = action.filePath ?? task.resumePath
        await page.setInputFiles(action.selector, filePath)
        break
      }
      case 'scroll': {
        await page.evaluate(() => window.scrollBy(0, 400))
        await page.waitForTimeout(300).catch(() => {})
        break
      }
      case 'wait': {
        await page.waitForTimeout(Math.min(action.waitMs ?? 2000, 5000)).catch(() => {})
        break
      }
      case 'submit': {
        const submitSel = action.selector ?? '[type="submit"]'
        await page.click(submitSel)
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
        break
      }
    }
  }
}
```

---

## File 5: `apps/worker/src/harness/agent-harness.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentHarness } from './agent-harness.js'
import type { ApplyTask } from './harness-prompt.js'

vi.mock('@jobcopilot/shared', () => ({
  callLlm: vi.fn(),
  loadWorkerAiConfig: vi.fn().mockResolvedValue({
    provider: 'minimax', model: 'MiniMax-M2.7', apiKey: 'test'
  }),
}))

vi.mock('./dom-extractor.js', () => ({
  extractFields: vi.fn().mockResolvedValue([
    { selector: '#name', type: 'text', label: 'Full Name', required: true, currentValue: '' },
    { selector: '#email', type: 'email', label: 'Email', required: true, currentValue: '' },
  ]),
}))

function makePage(urlOverride?: string) {
  return {
    url: vi.fn().mockReturnValue(urlOverride ?? 'https://boards.greenhouse.io/apply'),
    title: vi.fn().mockResolvedValue('Apply for Software Engineer'),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn(),
  }
}

const mockPool = { query: vi.fn() } as any

const task: ApplyTask = {
  jobId: 'job-1', userId: 'user-1', applyUrl: 'https://example.com/apply',
  personaId: 'p-1', resumePath: '/tmp/resume.pdf',
  jobTitle: 'Software Engineer', jobCompany: 'Acme',
  personaJson: JSON.stringify({ name: 'Jane Doe', email: 'jane@example.com' }),
}

function makeHarness(overrides: Partial<ConstructorParameters<typeof AgentHarness>[0]> = {}) {
  return new AgentHarness({
    userId: 'user-1', maxTurns: 30, dryRun: false, mode: 'dom', dbPool: mockPool, ...overrides,
  })
}

describe('AgentHarness', () => {
  beforeEach(() => vi.clearAllMocks())

  it('happy path: fills 2 fields then done → submitted', async () => {
    const { callLlm } = await import('@jobcopilot/shared')
    vi.mocked(callLlm)
      .mockResolvedValueOnce({ text: '{"type":"fill","selector":"#name","value":"Jane Doe","reasoning":"name field"}' })
      .mockResolvedValueOnce({ text: '{"type":"fill","selector":"#email","value":"jane@example.com","reasoning":"email field"}' })
      .mockResolvedValueOnce({ text: '{"type":"done","reasoning":"all fields filled"}' })

    const page = makePage()
    const result = await makeHarness().run(page as any, task)

    expect(result.status).toBe('submitted')
    expect(result.turns).toBe(3)
    expect(result.log).toHaveLength(3)
    expect(result.log[0].action.type).toBe('fill')
  })

  it('maxTurns exceeded → failed with error message', async () => {
    const { callLlm } = await import('@jobcopilot/shared')
    vi.mocked(callLlm).mockResolvedValue({ text: '{"type":"scroll","reasoning":"looking for more"}' })

    const result = await makeHarness({ maxTurns: 3 }).run(makePage() as any, task)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('maxTurns')
    expect(result.turns).toBe(3)
  })

  it('dry-run: fill action logged but page.type not called', async () => {
    const { callLlm } = await import('@jobcopilot/shared')
    vi.mocked(callLlm)
      .mockResolvedValueOnce({ text: '{"type":"fill","selector":"#name","value":"Jane","reasoning":"fill name"}' })
      .mockResolvedValueOnce({ text: '{"type":"done","reasoning":"done"}' })

    const page = makePage()
    const result = await makeHarness({ dryRun: true }).run(page as any, task)

    expect(page.type).not.toHaveBeenCalled()
    expect(page.fill).not.toHaveBeenCalled()
    expect(result.log[0].action.type).toBe('fill')
    expect(result.status).toBe('submitted')
  })

  it('manual escalation: LLM returns manual → status manual', async () => {
    const { callLlm } = await import('@jobcopilot/shared')
    vi.mocked(callLlm).mockResolvedValueOnce({
      text: '{"type":"manual","reasoning":"CAPTCHA detected on page"}',
    })

    const result = await makeHarness().run(makePage() as any, task)
    expect(result.status).toBe('manual')
    expect(result.error).toContain('CAPTCHA')
    expect(result.turns).toBe(1)
  })
})
```

---

## Validation (run in this exact order)

```bash
# Step 1: Check shared package types
cd packages/shared
npx tsc --noEmit
# Expected: 0 errors

# Step 2: Check worker types
cd apps/worker
npx tsc --noEmit
# Expected: 0 errors

# Step 3: New harness tests only
pnpm --filter worker test -- src/harness/agent-harness.test.ts
# Expected: 4/4 pass

# Step 4: Full regression (all 17+ worker tests)
pnpm --filter worker test
# Expected: all green

# Step 5 (optional, requires env): dry-run integration
# Terminal 1:
pnpm --filter worker dev
# Terminal 2:
pnpm --filter worker exec tsx scripts/enqueue-dry-run.ts \
  --url https://boards.greenhouse.io/booking/jobs/12345 \
  --user-id test-user-1
# Expected: worker logs per-turn JSON, writes status: 'dry-run' to apply_results
```

---

## PR Checklist

- [ ] 5 files created (llm.ts in shared + 4 in harness/)
- [ ] packages/shared/src/index.ts exports callLlm and loadWorkerAiConfig
- [ ] agent-harness.ts ≤ 280 lines
- [ ] dom-extractor.ts ≤ 150 lines
- [ ] 4 tests all pass
- [ ] 0 TypeScript errors in both packages/shared and apps/worker
- [ ] Zero imports from apps/web

Branch: `feat/36-agent-harness`
PR: `Closes #36` + two-layer AC table

Comment `@claude ready for review` when done.
