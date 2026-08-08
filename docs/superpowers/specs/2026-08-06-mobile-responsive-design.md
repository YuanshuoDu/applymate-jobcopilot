# ApplyMate Mobile Responsive Audit Design

**Date:** 2026-08-06
**Status:** Approved design

## Goal

Make the authenticated ApplyMate web shell usable at mobile widths (375px and 390px) without hiding actions, clipping content, or losing navigation. Preserve the current desktop layout and interaction behavior.

## Confirmed Mobile Navigation

The fixed bottom navigation has five equal-width destinations, in this order:

1. Jobs
2. Search
3. Home (center position)
4. Agent
5. More

More opens a compact mobile menu. The menu provides Gmail and Settings, closes after navigation, and can be dismissed without changing page state. The More item remains active while Gmail or Settings is open.

## Findings And Root Causes

- `OnboardingFlow.css` hides `.onboarding-skip` at `max-width: 720px`, removing the only per-step skip action on phones.
- `AppShell` renders the bottom bar as a fixed layer above a `100vh` clipped app container. Pages add inconsistent or no bottom clearance, so Jobs rows and Agent composer/welcome content end underneath the bar.
- The Agent workspace is a desktop two-column flex layout with fixed-width session console and chat sizing. At mobile widths its child content is pushed below the clipped shell instead of becoming a single scrollable column.
- Jobs list view renders a wide table without a mobile presentation. The table forces horizontal overflow and its final rows are hidden by the fixed bar.
- Settings keeps a two-column profile grid with `minmax(420px, 1fr)` and fixed label/input row assumptions. At phone widths the content exceeds the viewport; the mobile tab strip also has no visible overflow affordance.
- Search is implemented and renders at a direct URL, but the mobile nav has no Search destination and More navigates directly to Settings, so the page is unreachable through the mobile UI.

## Approach

Use a shared mobile shell contract plus page-specific responsive rules:

- Add a mobile safe-area variable and reserve it in the scrolling page container. Keep the fixed bar above content but never above the final interactive row.
- Make More a local menu state in `AppShell`; use the existing navigation callback for Gmail and Settings and close the menu on navigation, outside click, or Escape.
- At mobile widths, make the Agent workspace a vertical layout with an independently scrolling session area and a composer that stays reachable above the safe area. Keep the desktop split layout unchanged.
- At mobile widths, switch Jobs list view to compact job cards while retaining the table for desktop and keeping list/kanban controls functional. Ensure the page itself scrolls.
- At mobile widths, change Settings profile grids to one column, allow field labels to occupy a full row when needed, constrain controls to `min-width: 0`, and make the tab strip horizontally scrollable with stable touch targets.
- Keep Onboarding content scrollable and show Skip in every step footer at mobile widths. Respect the bottom safe area when onboarding is shown inside the app shell.
- Give Search a direct mobile nav entry and apply the same page padding/overflow contract.

## Error Handling And Accessibility

- Menu controls use buttons with `aria-expanded`, `aria-haspopup`, and an accessible label. Escape closes the menu.
- Responsive transformations must not remove keyboard focus, form labels, or `:focus-visible` styles.
- No mobile rule may rely on fixed content height for scrolling. Long text wraps and controls use `min-width: 0`.
- Existing API loading/error states remain unchanged; this work only changes layout and navigation presentation.

## Verification

- Add focused component tests for mobile nav order, More menu destinations, menu dismissal, and Onboarding skip visibility contract.
- Run the existing web test suite and typecheck.
- Use the in-app browser at 375x844 and 390x844 to navigate Home, Jobs, Search, Agent, More/Gmail, More/Settings, and the Onboarding flow. Capture screenshots and inspect for horizontal overflow, fixed-bar occlusion, clipped controls, and unreachable content.
- Re-check the default desktop viewport to confirm the sidebar, tables, Agent split view, Settings sidebar, and Onboarding three-column layout are unchanged.
