## Context

AgentHarness uses an LLM loop for all forms (~$0.001–0.05 per application). Greenhouse has a predictable, fixed form structure. A pre-programmed flow costs $0.00 and is 5× faster and more reliable. This is the same insight as ApplyPilot's pre-programmed flows that cover 80% of applications.

## Greenhouse Form Structure (standard)

Greenhouse apply pages always follow this structure:
```
Page 1: Personal info
  - First Name (input#first_name or input[name="job_application[first_name]"])
  - Last Name  (input#last_name)
  - Email      (input#email)  
  - Phone      (input#phone)
  - Location   (input#job_application_location or similar)
  - LinkedIn   (input containing 'linkedin' in name/id/label)
  - Resume upload (input[type=file] — SKIP for now, Phase 5)

Page 2: Custom questions (varies by employer)
  - textarea, select, input[type=text] — use persona data if key matches

Submit button: button[type=submit], input[type=submit]
```

## Acceptance Criteria

- [ ] **AC1**: New file `apps/worker/src/flows/greenhouse-flow.ts` exports:
  ```typescript
  export async function runGreenhouseFlow(
    page: Page,
    task: ApplyTask,
  ): Promise<HarnessResult>
  ```
  Returns same `HarnessResult` shape as AgentHarness.

- [ ] **AC2**: Personal info filling — try each field selector, fill if found:
  ```typescript
  const FIELD_MAP = [
    { selectors: ['#first_name', '[name*="first_name"]', '[name*="first"]'], personaKey: 'firstName' },
    { selectors: ['#last_name',  '[name*="last_name"]',  '[name*="last"]'],  personaKey: 'lastName' },
    { selectors: ['#email',      '[name*="email"]',      '[type="email"]'],   personaKey: 'email' },
    { selectors: ['#phone',      '[name*="phone"]',      '[type="tel"]'],     personaKey: 'phone' },
    { selectors: ['[name*="location"]', '[id*="location"]'],                  personaKey: 'location' },
    { selectors: ['[name*="linkedin"]', '[id*="linkedin"]', '[label*="LinkedIn"]'], personaKey: 'linkedinUrl' },
  ]
  ```
  For each field: try selectors in order → if visible → humanType(value).

- [ ] **AC3**: Custom question handling — after personal info, scan for unfilled text fields:
  ```typescript
  // Find all visible textarea and text inputs NOT already filled
  const customFields = await page.$$eval(
    'textarea:not([disabled]), input[type="text"]:not([disabled])',
    els => els.filter(el => !el.value).map(el => ({ 
      selector: ..., label: findLabel(el) 
    }))
  )
  // For each: look up persona by label key match → fill if found
  ```

- [ ] **AC4**: Submit — after filling, click submit:
  ```typescript
  const submitSel = 'input[type="submit"], button[type="submit"], .submit-button'
  await page.click(submitSel)
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  // Check URL for confirmation
  const url = page.url()
  const confirmed = /thank|success|confirmation|submitted/i.test(url)
  return { status: confirmed ? 'submitted' : 'manual', turns: 1, log: [] }
  ```

- [ ] **AC5**: URL detection helper in `apps/worker/src/flows/index.ts`:
  ```typescript
  export type FlowType = 'greenhouse' | 'workday' | null

  export function detectFlow(url: string): FlowType {
    if (/boards\.greenhouse\.io|grnh\.se|greenhouse\.io\/applications/i.test(url)) return 'greenhouse'
    if (/\.myworkdayjobs\.com/i.test(url)) return 'workday'
    return null
  }
  ```

- [ ] **AC6**: `apply-queue.ts` updated — check `detectFlow` before AgentHarness:
  ```typescript
  import { detectFlow } from '../flows/index.js'
  import { runGreenhouseFlow } from '../flows/greenhouse-flow.js'

  // Inside withCloakContext:
  const flow = detectFlow(applyUrl)
  let harnessResult: HarnessResult

  if (flow === 'greenhouse') {
    harnessResult = await runGreenhouseFlow(page, applyTask)
  } else {
    harnessResult = await harness.run(page, applyTask)
  }
  ```

- [ ] **AC7**: Unit tests `greenhouse-flow.test.ts` — mock page:
  - Happy path: all fields filled, submit clicked, URL matches → submitted
  - Missing field gracefully skipped (no error thrown)
  - No submit button found → returns manual

- [ ] **AC8**: `pnpm --filter worker tsc --noEmit` passes

## Tech Notes

- humanType helper: copy pattern from agent-harness.ts (`page.type(sel, ch, { delay: 50 + Math.random() * 70 })`)
- First try to `getPersonaValue(persona, key)` — a helper that checks exact key match, then case-insensitive partial match
- Never throw on missing fields — always continue to next field
- Files: `apps/worker/src/flows/greenhouse-flow.ts` (new), `apps/worker/src/flows/index.ts` (new), `apply-queue.ts` (update)

---
@codex Branch: `feat/59-greenhouse-flow`. PR with `Closes #59`. Comment `@claude ready for review` when done.
