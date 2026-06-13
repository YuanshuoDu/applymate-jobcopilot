# Auto-Apply Architecture Design

> **Date:** 2026-05-21
> **Status:** Approved — implementation in progress
> **Owner:** Claude (PM) · **Repo:** YuanshuoDu/applymate-jobcopilot

---

## 1. Problem Statement

ApplyMate currently requires users to be present for every form submission (Extension assisted mode). The product goal is to also support fully autonomous job application — user sets preferences, the system discovers, scores, and applies to matching jobs 24/7 without human intervention.

Inspiration: ApplyPilot (open source, 1k+ stars) proves this is technically achievable. Their approach: Claude Code CLI + Playwright MCP. Our approach: custom AgentHarness + CloakBrowser + ModelRouter (more flexible, no Claude Code dependency).

---

## 2. Two Modes — Side by Side

| Dimension | Mode A: Assisted | Mode C: Unattended |
|---|---|---|
| Trigger | User clicks "Fill Form" in Extension | BullMQ task queue (user offline) |
| Browser | User's Chrome (content script) | Server CloakBrowser (stealth headless) |
| Form detection | `form-scanner.ts` (content script) | `dom-extractor.ts` (Playwright evaluate) |
| Field filling | `auto-fill.ts` + LLM one-shot | `AgentHarness` perception-action loop |
| Confirmation | User reviews before submit | Agent verifies, logs result |
| LLM model | User-selected via Settings (`formFill`) | User-selected via Settings (`autoApply`) |
| Default model | MiniMax M2.7 (platform key) | MiniMax M2.7 (platform key) |

Mode A (existing) is unchanged. This spec covers Mode C.

---

## 3. Core Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Next.js App (Vercel)                                           │
│  • UI: Settings → Auto-Apply toggle + model config             │
│  • API: POST /api/jobs/{id}/auto-apply → enqueues BullMQ task  │
│  • DB: apply_results table (Postgres/D1)                       │
└────────────────────────┬────────────────────────────────────────┘
                         │ BullMQ (Redis)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Worker Service (Fly.io / Hetzner)                              │
│                                                                 │
│  ┌─ CloakBrowser Pool ─────────────────────────────────────┐   │
│  │  • Per-user profile dir (persistent cookies)            │   │
│  │  • humanize: true (realistic mouse/keyboard timing)     │   │
│  │  • geoip: true (timezone matches proxy)                 │   │
│  │  • Max 3 concurrent contexts                            │   │
│  └───────────────────┬─────────────────────────────────────┘   │
│                      │ Page object                             │
│  ┌─ AgentHarness ───────────────────────────────────────────┐  │
│  │                                                          │  │
│  │  while not done and turns < maxTurns:                   │  │
│  │    fields = dom_extractor(page)     ← perceive DOM      │  │
│  │    if complex: screenshot = page.screenshot()  ← vision │  │
│  │    action = ModelRouter.call(                           │  │
│  │      system=persona+job_context,                        │  │
│  │      user=fields_json,                                  │  │
│  │      feature='autoApply'            ← user's model      │  │
│  │    )                                                    │  │
│  │    execute_action(page, action)      ← Playwright       │  │
│  │    turns++                                              │  │
│  │                                                         │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  write apply_result → notify user                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. AgentHarness Design

### 4.1 Perception Layer

**Mode: DOM** (default, cheap)
- Playwright `page.evaluate()` runs in browser context
- Extracts all interactable form fields: selector, type, label, current value, options
- Port of existing `form-scanner.ts` logic from Extension

**Mode: Vision** (fallback for complex forms)
- `page.screenshot({ type: 'webp', quality: 80 })`
- Base64 encode → send to vision-capable LLM (Claude Sonnet, GPT-4o, or MiniMax M2.7 if it supports vision)
- More expensive but handles highly dynamic forms

**Mode: Hybrid** (recommended)
- Always run DOM first
- If DOM extraction returns < 2 fields OR page has iframe-heavy structure → fall back to vision

### 4.2 Action Set

```typescript
type ActionType =
  | 'fill'      // page.fill(selector, value)
  | 'click'     // page.click(selector)
  | 'select'    // page.selectOption(selector, value)
  | 'upload'    // page.setInputFiles(selector, filePath)
  | 'scroll'    // page.evaluate(() => window.scrollBy(0, N))
  | 'wait'      // page.waitForTimeout(ms) — max 5s
  | 'submit'    // click + waitForNavigation
  | 'done'      // agent declares success
  | 'manual'    // agent escalates to human
```

### 4.3 LLM Prompt Design

**System prompt** (sent once, sets the context):
```
You are an autonomous job application agent. Fill forms accurately using ONLY 
the candidate's provided data. NEVER fabricate any information.

CANDIDATE DATA:
{persona_json}

JOB CONTEXT:
Title: {job.title}
Company: {job.company}
Key Requirements: {job.keywords}

RULES:
1. Fill every required field visible on screen.
2. For file upload fields: use the provided resume/cover letter paths.
3. Never guess values not present in candidate data — use empty string instead.
4. When all visible fields are filled, click Next/Submit.
5. If you see a CAPTCHA or login-wall, return type: "manual".
6. Return ONLY valid JSON matching the AgentAction schema.
```

**User message** (sent each turn):
```
Current page URL: {url}
Current page title: {title}

VISIBLE FORM FIELDS:
{perceived_fields_json}

What is the next action? Return JSON with type, selector, value, reasoning.
```

### 4.4 Human-Mimicking Behavior

- Typing: 50-120ms per character (not instant)
- Mouse: Random small offset before click (±3px)
- Scroll: Smooth, 300-500ms duration
- Between actions: 200-800ms random delay
- All via `humanize: true` in CloakBrowser + our custom delays in execute layer

---

## 5. ModelRouter Integration

```typescript
// Worker calls this to get the right model config per user
const aiConfig = await loadUserAiConfig(userId, 'autoApply')
// → Free users: MiniMax M2.7 (platform key, ~$0.001/turn)
// → Pro users: whatever they set in Settings
// → Users with own key: their model of choice

const decision = await modelChat(messages, aiConfig, 2048)
```

**MiniMax M2.7 suitability for autoApply:**
- Supports JSON output mode ✅
- 200K context window (handles large forms) ✅
- Tool use / function calling ✅ (for structured action output)
- ~$0.0003/1K tokens (very cheap per turn) ✅
- Vision support: check MiniMax M2.7 specs — if not, use DOM mode as default for MiniMax users

**Cost estimate per application:**
- Average form: ~10 turns
- Per turn: ~1K input + 200 output tokens
- MiniMax M2.7: ~$0.001 per application (essentially free)
- Claude Sonnet 4.6: ~$0.05 per application
- GPT-4o-mini: ~$0.003 per application

---

## 6. CAPTCHA Strategy

CloakBrowser prevents most CAPTCHAs from appearing (reCAPTCHA v3 score 0.9, Turnstile auto-pass). For the remainder:

```
CAPTCHA detected?
  │
  ├─ Cloudflare Turnstile → CloakBrowser handles automatically
  ├─ reCAPTCHA v3 (score-based) → CloakBrowser score ≥ 0.7 → passes
  ├─ reCAPTCHA v2 (checkbox) → CapSolver API (if key present) → ~$0.001/solve
  └─ Phone verification / unsolvable → agent returns type: 'manual'
                                       → user gets push notification
                                       → task saved, user can complete manually
```

---

## 7. Per-User Settings Integration

The existing Settings page already has `AiModelSettings` component with `FeatureId` support. Two new features added to `model-router.ts`:

| FeatureId | Label | Default Model |
|---|---|---|
| `autoApply` | 自动申请 Agent（无人值守） | MiniMax M2.7 |
| `jobScoring` | 职位评分 + 关键词提取 | MiniMax M2.7 |

Settings UI:
```
Settings → AI Models → 
  [自动申请 Agent] [下拉选择模型] [API Key 输入框]
  [职位评分 + 关键词提取] [下拉选择模型] [API Key 输入框]
```

Users can switch from MiniMax to Claude/GPT-4o/DeepSeek for better quality, at their own cost.

---

## 8. @claude Collaboration Protocol

Codex mentions `@claude` in GitHub comments to trigger PM response. Added to `CLAUDE.md`:

- Every PM monitoring tick now checks for unresponded `@claude` mentions first
- `@claude ready for review` → immediate PR review
- `@claude blocked on #N` → spec clarification within next tick
- Response time: 4-30 minutes depending on loop cadence

---

## 9. Issue Inventory (as of 2026-05-21)

### Phase 1 — Free ATS Sources + Enrichment (in progress)
| # | Title | Status |
|---|-------|--------|
| #16 | Greenhouse source | ✅ Done |
| #17 | Lever source | 🔄 In progress |
| #18 | EU employer registry | spec-ready |
| #19 | JSON-LD T1 extractor | spec-ready |
| #20 | CSS T2 selectors | spec-ready |
| #21 | Cascade wiring | spec-ready |

### Phase 2 — Workday + CloakBrowser Gate
| # | Title | Status |
|---|-------|--------|
| #30 | Workday CXS API + EU tenants | spec-ready |
| #31 | CloakBrowser PoC GO/NO-GO | spec-ready |

### Phase 3 — Worker Infrastructure
| # | Title | Status |
|---|-------|--------|
| #32 | Worker skeleton (BullMQ + CloakBrowser pool) | spec-ready (blocked on #31) |

### New Issues Added Today
| # | Title | Status |
|---|-------|--------|
| #35 | Scoring KEYWORDS field + jobScoring FeatureId | spec-ready |
| #36 | AgentHarness perception-action loop | spec-ready (blocked on #32) |

---

## 10. Success Criteria

The auto-apply system is "shipped" when:

- [ ] User toggles "Auto-Apply" in Settings → system starts processing queued jobs
- [ ] AgentHarness successfully submits a real application on Greenhouse (dry-run verified first)
- [ ] CloakBrowser passes all 8 target sites in PoC (#31)
- [ ] MiniMax M2.7 (platform default) can fill a standard Greenhouse form in ≤ 15 turns
- [ ] Per-application LLM cost ≤ $0.005 for MiniMax (Free tier)
- [ ] CAPTCHA encounter rate < 5% across all apply attempts
- [ ] Users can switch to Claude/GPT-4o in Settings for better quality
- [ ] `apply_results` dashboard shows real-time submission status

---

## 11. Open Decisions

1. **MiniMax vision support**: Does M2.7 support image input? If not, DOM-only mode for Free users, vision only for Claude/GPT-4o users.
2. **Worker hosting**: Fly.io vs Hetzner VPS (Phase 3.5 open question from design doc §10 Q1).
3. **Stagehand vs DIY**: Consider using [Stagehand](https://github.com/browserbase/stagehand) as the action layer to accelerate Phase 4+ development. Decision after CloakBrowser PoC.
