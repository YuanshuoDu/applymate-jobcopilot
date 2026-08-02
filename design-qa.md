# Agent workspace design QA

## Evidence

- New-chat reference: `C:\Users\Steven.du\AppData\Local\Temp\codex-clipboard-7f876dab-aaf3-45ab-be79-a53f3d0052b3.png`.
- Default-model composer reference: `C:\Users\Steven.du\AppData\Local\Temp\codex-clipboard-ebb6702b-c0f2-4df2-82cd-3f8e09881b25.png`.
- Implementation: in-app browser capture at `http://localhost:3001/?page=agent`, desktop viewport `1280 × 720`, captured 2026-08-02. The visible implementation is rendered at the same desktop density (`1×`) and the tab remains open as the local deliverable.

## Comparison scope

The supplied composer image identifies a control to remove rather than a layout to reproduce: basic Agent chat must use its server-resolved default model and must not expose a per-message selector. The implementation was compared at the same composer state (empty input, no menu open); the app shell and new-chat content are intentionally outside the source crop.

## Findings

- No actionable P0/P1/P2 findings.
- The large model selector shown in the source crop is absent from the rendered composer. The composer now keeps only context attachment and send controls, producing the requested direct-chat state.
- The source does not specify an alternative in-chat advanced-model UI. ApplyMate's existing Settings → AI Models feature-level picker remains the advanced, persisted place to choose a model for the `agent` feature; it is intentionally not duplicated in the composer.

## Required fidelity surfaces

| Surface | Result | Evidence |
| --- | --- | --- |
| Fonts and typography | Pass | Composer continues to inherit existing ApplyMate font, input sizing, and button weight. |
| Spacing and layout rhythm | Pass | Removing the wide selector leaves the established 28px context control aligned with the send control; no composer overflow or shifted input. |
| Colors and visual tokens | Pass | Existing background, border, primary send state, and muted disabled state are unchanged. |
| Image and asset fidelity | Pass | Neither target requires raster assets. Existing product icons remain unchanged. |
| Copy and content | Pass | The generic model label is removed; the input remains focused on the user task. |

## Functional checks

- Normal chat request body contains only `sessionId` and `messages`; it cannot supply a client-selected model.
- Server ignores a legacy client `model` value and uses the authenticated user's resolved `agent` feature configuration.
- Targeted tests: 17 tests passed.
- Full Web suite passed; TypeScript check passed.
- Browser-rendered Agent page confirms the selector is absent and the composer remains usable.

## Final result

passed
