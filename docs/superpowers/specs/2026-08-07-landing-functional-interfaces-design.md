# Landing Page Functional Interfaces Design

## Goal

Make the public landing page honest and usable by replacing its fake contact submission and placeholder footer links with real, testable behavior while preserving the existing visual design.

## Scope

### Unified pricing catalogue

Pricing is a product configuration, not landing-page copy. Add a database-backed plan catalogue keyed by the existing `free`, `pro`, and `enterprise` plan values. Each plan stores a display name, integer price in minor currency units, ISO currency, billing interval, description, ordered feature list, optional badge, CTA label, trial days, active flag, and sort order. The initial seed uses the current in-product settings baseline: Free `€0` forever, Pro `€12` per month, and Team `€29` per month. The `enterprise` enum value is displayed as Team by default but remains the stable internal key.

Expose one unauthenticated `GET /api/plans` endpoint containing only active public fields. The landing page server component uses the same catalogue helper for an SSR-safe pricing payload, while the endpoint remains the public contract for the signed-in settings billing view and other clients. The signed-in settings billing view consumes the same response, mapping `enterprise` to the existing Team plan label. A shared server-side catalogue helper owns the default seed shape and normalization so the public API, landing page, settings view, and admin API cannot drift.

Expose an authenticated, administrator-only `GET/PATCH /api/admin/v1/plans` endpoint. The endpoint validates plan keys, price/currency/interval, feature arrays, trial days, sort order, and requires at least one active Free plan. It returns redacted, editable catalogue data and uses the existing `requireSettingsAdmin` guard. Add an admin Plans screen linked from the existing observability admin surface; administrators can edit plan copy, price, trial, features, badge, CTA and active/order state, then save and refresh the public catalogue. Plan membership assignment remains a separate user-setting operation and is not changed here.

### Contact form

Add `POST /api/contact` for public contact submissions. The endpoint accepts `name`, `email`, and `message`, trims input, validates the email format, and enforces bounded lengths. Invalid requests return a `400` JSON error. The route sends a plain-text and HTML message through the existing Resend integration to `CONTACT_TO_EMAIL` or the configured support address. It returns `201` on successful delivery. If Resend or the sender/recipient configuration is missing, it returns a clear `503` error instead of claiming that the message was sent. Provider failures also return `503` without exposing provider details.

The landing form calls this endpoint and has four observable states: idle, submitting, sent, and error. A failed request keeps the user's entered values so they can retry. The form remains unauthenticated and does not store message content in the database.

### Links and calls to action

Remove placeholder `href="#"` values from the landing page. Keep existing `/register` and `/login` routes for all signup and sign-in CTAs. Keep product section links as page anchors. Use the verified repository URL for GitHub. Use `mailto:` links with useful subjects for support, privacy, legal, company, press, and integration requests where the repository has no dedicated public route. These links must be represented by a small local configuration so they are easy to audit and cannot silently become dead anchors.

The Free pricing card links to registration. Pro trial and Team sales actions link to the contact section and prefill an explicit request because checkout and billing are explicitly out of scope while no public billing endpoint exists.

### Product intent and responsive interactions

Feature cards are actionable entry points rather than static claims. Resume, jobs, Gmail and agent cards use `/register?callbackUrl=...` links that return a newly authenticated user to the selected product page; the extension card uses the verified repository URL. Callback values accept only same-origin relative paths and are shared by login and registration, including OAuth. The mobile navigation exposes the same section links and auth actions, has an accessible menu button, and closes on Escape. FAQ rows use keyboard-operable disclosure buttons. A successful contact submission offers a reset action for another message, while a failed submission keeps the entered values.

## Data flow

```text
Landing form -> POST /api/contact -> validate -> Resend -> support inbox
                                      \-> JSON error -> form retry state
```

The browser never receives provider credentials or raw provider error messages.

## Security and reliability

- Reject non-JSON bodies and unknown/missing required fields.
- Bound name, email, and message sizes to prevent oversized requests.
- Do not log message bodies or email addresses in the route.
- Escape user content through the email provider's structured `text`/`html` fields; HTML content is encoded before interpolation.
- Use the same environment-variable conventions as password reset: `RESEND_API_KEY` and `EMAIL_FROM`.
- Support an optional `CONTACT_TO_EMAIL`, falling back to `NEXT_PUBLIC_SUPPORT_EMAIL` and then `hello@applymate.ai`.

## Testing

- Catalogue helper tests cover the default plans, numeric price formatting, stable ordering, and normalization of malformed feature data.
- Public catalogue route tests cover active-only filtering and the safe public response shape.
- Admin catalogue route tests cover access denial, valid updates, invalid prices/features, and the invariant that Free cannot be disabled.
- Route tests mock `fetch` and cover invalid JSON, invalid fields, missing configuration, successful delivery, and provider failure.
- Landing action tests verify safe feature callback links, paid-plan contact intent, pricing data rendering, contact submission feedback, errors preserving the form, keyboard-operable disclosure/menu controls, and no `href="#"` remains in the rendered footer links.
- Settings and admin plan screens test that they render the same plan keys and update after a successful save.
- Run the focused Vitest files, the web TypeScript check, and a local browser smoke test for the public page.

## Out of scope

- Stripe or other billing/checkout integration.
- Database-backed lead storage or an admin contact inbox.
- New legal or company content pages; mail links are used until verified routes exist.
- Any visual redesign or changes to the existing landing-page layout.
