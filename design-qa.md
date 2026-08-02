# Agent new-chat design QA

## Evidence

- Reference: `C:\Users\Steven.du\AppData\Local\Temp\codex-clipboard-7f876dab-aaf3-45ab-be79-a53f3d0052b3.png` — Codex-style new-chat landing state.
- Implementation: verified in the in-app browser at `http://localhost:3000/?page=agent` on 2026-08-02. The verified tab remains open as the local deliverable.

## Comparison

| Check | Result | Notes |
| --- | --- | --- |
| Empty-state purpose | Pass | A new Agent conversation now opens an actionable, centered workspace instead of an empty pane. |
| Hierarchy | Pass | A primary question, short safety explanation, then four task starters match the reference interaction pattern. |
| Layout | Pass | The landing content is centered in the stream, constrained to a readable width, and the cards use a four-column desktop grid with a two-column mobile fallback. |
| Existing product language | Pass | ApplyMate tokens, typography, lucide icons, shell navigation, and composer are retained rather than introducing a separate visual system. |
| Interaction | Pass | Each starter only pre-fills a truthful, reviewable task in the composer. It does not start a job search or submit an application. `+ New chat` clears the draft and restores the same landing state. |
| Accessibility | Pass | The welcome area is named, task starters are semantic buttons, and the existing composer remains keyboard-accessible. |

## Intentional differences

The reference is a general-purpose code-agent landing screen. This implementation uses ApplyMate-specific job-search actions and keeps the product's persistent left session rail and bottom composer, so it fits the existing Agent workflow rather than cloning Codex chrome.

## Verification

- `pnpm --filter web test -- src/components/agent-workspace/AgentNewChatWelcome.test.tsx src/components/agent-workspace/AgentUnifiedStream.helpers.test.ts` — 3 tests passed.
- `pnpm --filter web exec tsc --noEmit --skipLibCheck` — passed.
- Browser flow: initial empty state → task starter pre-fills composer → `+ New chat` restores the landing state — passed.

## Final result

**passed**
