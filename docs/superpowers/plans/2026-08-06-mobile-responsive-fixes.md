# Mobile Responsive Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** Make the authenticated ApplyMate web experience usable at 375px and 390px while preserving desktop behavior and the approved five-item mobile navigation.

**Architecture:** Keep navigation state in `AppShell`, expose the mobile navigation contract as pure exported data for tests, and use a local More popover for Gmail and Settings. Establish one CSS safe-area contract for the fixed bottom bar, then add narrowly scoped mobile rules to page roots and the existing Agent/Onboarding layouts. Jobs keeps its desktop table and adds a compact mobile card rendering to avoid horizontal overflow.

**Tech Stack:** Next.js 15, React 19, TypeScript, Vitest, existing inline styles plus `apps/web/src/app/globals.css`, in-app Browser viewport overrides.

---

### Task 1: Add navigation contract tests

**Files:**
- Modify: `apps/web/src/components/layout/AppShell.tsx`
- Modify: `apps/web/src/__tests__/layout/navigation.test.ts`

- [ ] **Step 1: Write the failing tests**

Export `getMobileNavItems` and `getMobileMoreItems` from `AppShell` and add these assertions to `navigation.test.ts`:

```ts
it('keeps the approved mobile navigation order', () => {
  expect(getMobileNavItems().map(item => item.id)).toEqual(['jobs', 'search', 'dashboard', 'agent', 'more'])
  expect(getMobileNavItems()[2].label).toBe('Home')
})

it('puts Gmail and Settings in the mobile More menu', () => {
  expect(getMobileMoreItems().map(item => item.id)).toEqual(['gmail', 'settings'])
})
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run `pnpm --filter web test -- src/__tests__/layout/navigation.test.ts`. It must fail because the exported helpers do not exist yet.

- [ ] **Step 3: Implement the smallest navigation data contract**

Replace the current `MOB_NAV` array with an exported `getMobileNavItems()` returning the five approved items and add an exported `getMobileMoreItems()` returning Gmail and Settings. Keep existing `Page` values for real routes and use a separate `'more'` union member only for the menu trigger.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run the same Vitest command and expect the navigation suite to pass.

- [ ] **Step 5: Commit**

Run `git add apps/web/src/components/layout/AppShell.tsx apps/web/src/__tests__/layout/navigation.test.ts` and commit with `test(layout): define mobile navigation contract`.

### Task 2: Implement More menu and shared mobile safe area

**Files:**
- Modify: `apps/web/src/components/layout/AppShell.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Write the failing behavior test**

Extend the layout test with a pure helper assertion that Settings and Gmail are not in the five-item bar and remain in `getMobileMoreItems()`. Use the existing navigation test command to verify the expected failure before implementation.

- [ ] **Step 2: Implement menu state and dismissal**

Add `mobileMoreOpen` state. The More button uses `aria-expanded`, `aria-haspopup="menu"`, and `aria-label="More"`; clicking it toggles the popover without navigating. Render a fixed-position menu above the bar with Gmail and Settings buttons, close it from `navigatePage`, Escape, and an outside pointer handler. Navigation buttons call `navigatePage(item.id)` and close the menu.

- [ ] **Step 3: Establish safe-area CSS**

In the mobile root variables add `--mobile-nav-h: 60px` and `--mobile-content-inset: calc(var(--mobile-nav-h) + env(safe-area-inset-bottom))`. Keep `#mobile-bottom-bar` fixed with `padding-bottom: env(safe-area-inset-bottom)` and `min-height: var(--mobile-nav-h)`. Give `#main-content` `padding-bottom: var(--mobile-content-inset)` and `min-width: 0; min-height: 0`. Add a `.mobile-scroll-safe-area` utility for nested scroll regions that need trailing padding.

- [ ] **Step 4: Run tests and inspect the DOM contract**

Run the focused navigation suite and `pnpm --filter web tsc --noEmit --skipLibCheck`. Confirm no desktop rules are changed outside the mobile media query.

- [ ] **Step 5: Commit**

Commit with `fix(layout): add mobile More menu and safe area`.

### Task 3: Repair Jobs and Search on mobile

**Files:**
- Modify: `apps/web/src/components/pages/JobsPage.tsx`
- Modify: `apps/web/src/components/pages/SearchPage.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Write failing layout tests**

Add pure view-model tests next to the Jobs page for the mobile card projection: a job card must retain company, role, status, match score, and date. Add a Search navigation assertion through the exported mobile nav contract. Run them and confirm failure for the missing helper.

- [ ] **Step 2: Implement compact mobile Jobs cards**

Extract a small `MobileJobCard` component from the existing row data. Render it only below 768px through a `.jobs-mobile-list` wrapper and hide the desktop table at that width; keep `ListView` and kanban controls unchanged. The card uses `min-width: 0`, wraps the role, and includes the existing row click and checkbox actions. Add mobile page padding that includes `var(--mobile-content-inset)`.

- [ ] **Step 3: Make Jobs controls wrap without clipping**

Use a class on the Jobs header/toolbars and add mobile CSS with `padding-inline: 16px`, `gap: 8px`, full-width search input, and controls that wrap into stable rows. Remove fixed-width assumptions from the toolbar only at mobile widths.

- [ ] **Step 4: Apply the shared page contract to Search**

Give the Search page root a `min-width: 0`, `padding-bottom: var(--mobile-content-inset)` at mobile widths, and make its TopBar action wrap below the title. The new Search nav button routes through `navigatePage('search')`.

- [ ] **Step 5: Run focused tests and commit**

Run the Jobs/Search tests and commit with `fix(jobs): make list and search usable on mobile`.

### Task 4: Repair Agent mobile scrolling

**Files:**
- Modify: `apps/web/src/components/pages/AgentPlaygroundPage.tsx`
- Modify: `apps/web/src/components/agent-workspace/AgentUnifiedStream.tsx`
- Modify: `apps/web/src/components/agent-workspace/AgentSessionConsole.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Add a failing mobile workspace contract test**

Add a render test for the workspace shell that asserts the session console and composer are both present in the mobile DOM order and the stream has the safe-area class. Run it before changing the mobile CSS.

- [ ] **Step 2: Make the mobile workspace scrollable to its end**

Keep the existing desktop split layout. At `max-width: 760px`, give `.agent-workspace-layout` `min-height: 0`, `overflow-y: auto`, `padding-bottom: var(--mobile-content-inset)`, and `overscroll-behavior-y: contain`. Keep the session console capped but scrollable, and let the stream/composer use `flex: 0 0 auto` with `min-width: 0` so the complete composer can be reached.

- [ ] **Step 3: Remove fixed-width overflow in stream children**

Add mobile rules for transcript blocks, composer menus, and action cards to use `max-width: 100%`, `overflow-wrap: anywhere`, and `min-width: 0`. Menus opened above the composer clamp their width to `calc(100vw - 32px)`.

- [ ] **Step 4: Verify and commit**

Run the Agent component tests, TypeScript check, and commit with `fix(agent): preserve mobile workspace scroll area`.

### Task 5: Repair Settings and Onboarding mobile layout

**Files:**
- Modify: `apps/web/src/components/pages/SettingsPage.tsx`
- Modify: `apps/web/src/components/onboarding/OnboardingFlow.css`
- Modify: `apps/web/src/components/onboarding/OnboardingFlow.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Add failing contract tests**

Add an Onboarding render test that checks every skippable step has the `Skip for now` control and a Settings layout test that checks the profile form uses a mobile-safe class. Run them before style changes.

- [ ] **Step 2: Keep Onboarding Skip visible**

Remove the mobile `.onboarding-skip { display: none; }` rule. Keep the footer visible with `padding-bottom: calc(18px + env(safe-area-inset-bottom))`, make its action group wrap, and keep `.onboarding-content` independently scrollable with trailing safe-area padding.

- [ ] **Step 3: Make Settings content fit and scroll**

Add classes to the profile grid and field rows. At mobile widths switch profile grids to one column, let labels use `width: 100%` when the row cannot fit, set children to `min-width: 0; max-width: 100%`, and make selects/buttons shrink or wrap. Keep the tab strip horizontal with `overflow-x: auto`, `scrollbar-width: none`, and at least 40px vertical touch targets. Add bottom safe-area padding to `.settings-content`.

- [ ] **Step 4: Verify and commit**

Run Onboarding/Settings tests and commit with `fix(settings): prevent mobile clipping and restore onboarding skip`.

### Task 6: Full verification and delivery

**Files:**
- Modify only files from Tasks 1-5 if verification reveals a regression.

- [ ] **Step 1: Run the full test suite**

Run `pnpm --filter web test` and record the exact test count and failures.

- [ ] **Step 2: Run typecheck**

Run `pnpm --filter web tsc --noEmit --skipLibCheck` and resolve only regressions introduced by this work.

- [ ] **Step 3: Run browser audit**

At 375x844 and 390x844 navigate Home, Jobs, Search, Agent, More/Gmail, and More/Settings. Verify the fixed bar does not cover the last interactive content, `document.documentElement.scrollWidth <= innerWidth`, the More menu opens/closes, and no primary route is absent. Capture screenshots for each viewport. Reset the viewport and re-check desktop sidebar/table/split layouts.

- [ ] **Step 4: Review diff and commit**

Run `git diff --check`, inspect `git diff --stat`, and commit the final changes with a scoped conventional message.

- [ ] **Step 5: Push**

Run `git push origin HEAD` and report the resulting commit hash and push output. Do not claim delivery if authentication or remote conflicts block the push.
