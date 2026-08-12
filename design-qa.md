# Agent workspace design QA

## Evidence

- New-chat reference: `C:\Users\Steven.du\AppData\Local\Temp\codex-clipboard-7f876dab-aaf3-45ab-be79-a53f3d0052b3.png`.
- Composer reference: `C:\Users\Steven.du\AppData\Local\Temp\codex-clipboard-ebb6702b-c0f2-4df2-82cd-3f8e09881b25.png`.
- Implementation: in-app browser capture at `http://localhost:3001/?page=agent`, desktop viewport `1280 × 720`, captured 2026-08-02 at `1×` density. The local Agent tab remains open as the deliverable.

## Comparison scope

The reference shows the composer’s model-selector position. The required variation keeps that position visible, but turns it into a neutral, locked advanced-feature affordance. Basic chat remains tied to the server-resolved Agent default rather than a temporary per-message choice.

## Findings

- No actionable P0/P1/P2 findings.
- The composer displays a compact grey `Lock` + `Model selection` + `Advanced` control in the former selector position. It is visually subordinate to the context and send actions.
- Activating the control reveals an accessible explanation and a functional route to `/?page=settings&tab=apiKeys`, where the existing Feature Model Routing picker opens with the `AI Agent` model override available.
- The first implementation iteration had removed the selector area completely. It was corrected to the locked, grey advanced prompt described above; browser verification confirmed the revised state and destination.

## Required fidelity surfaces

| Surface | Result | Evidence |
| --- | --- | --- |
| Fonts and typography | Pass | The compact label and badge inherit the existing ApplyMate composer scale and weight hierarchy. |
| Spacing and layout rhythm | Pass | The lock entry follows the existing 28px composer-control rhythm and does not shift the input or send action. |
| Colors and visual tokens | Pass | Grey border, secondary surface, muted label, and subdued badge communicate a locked non-default capability without imitating an enabled model picker. |
| Image and asset fidelity | Pass | The target contains standard UI controls only. The existing lucide icon library supplies the lock glyph; no raster or custom-drawn assets are required. |
| Copy and content | Pass | The control says `Model selection` and `Advanced`; the prompt states that basic chat keeps the default Agent model. |

## Functional checks

- Basic chat requests omit the client model field, and the API rejects legacy client model overrides in favor of the authenticated Agent feature configuration.
- Locked entry → advanced explanation → `Open advanced settings` reaches Settings → Keys & connections with Feature Model Routing and the AI Agent picker visible.
- Targeted tests: 18 tests passed.
- TypeScript check passed.
- Browser-rendered Agent and Settings states were verified; no console errors on the clean Agent preview.

## Final result

passed

## Popup redesign QA

### Result

**Blocked for rendered browser QA** — the implementation passed static checks and production build, but the connected browser refused to open the `chrome-extension://` Popup URL under its security policy. No rendered screenshot is claimed.

### Design source

- Selected direction: third generated ApplyMate Popup concept
- Source: `C:\Users\Steven.du\.codex\generated_images\019ff63a-e22d-7512-b80c-f9526f5e6522\exec-41fd7237-ba9b-40f7-a24a-8ecb6f0dfd7d.png`
- Intended viewport: 360px-wide Chrome Popup, authenticated state with a detected job

### Implemented visual state

- ApplyMate AI header with branded icon, product subtitle, settings action, and account menu
- Detected job-page status card with source icon and success state
- Current job card with company mark, role, company, location, match ring, and fit status
- Stacked Save job, Analyze match, and gradient Prepare application actions
- Saved jobs count and Open sidebar footer shortcuts
- Empty state retained for pages without a detected job
- Indigo/lavender/white palette, restrained borders, rounded cards, and Lucide line icons

### Interaction wiring

- Popup refreshes the active tab with `PING`, reads the current scraped job, and listens for `JOB_SCRAPED`
- Save job uses the existing background `SAVE_JOB` flow, including identity deduplication and auth recovery
- Analyze match uses the active resume and existing `/api/ai/score` client
- Prepare application and Open sidebar reuse background `OPEN_SIDE_PANEL` fallback behavior
- Dashboard, settings, sign-out, and empty-state job-board links remain connected

### Verification

- `pnpm --filter @jobcopilot/extension typecheck` — passed
- `pnpm --filter @jobcopilot/extension build` — passed
- `pnpm --filter @jobcopilot/extension test` — 3 files / 8 tests passed
- Rendered Popup screenshot — blocked by browser security policy; requires manual Chrome extension reload and click-through QA
