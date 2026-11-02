# Chrome Web Store release preparation — 0.1.21

Date: 2 November 2026  
Branch: fix/chrome-web-store-release  
Starting revision: e57977dc8ad0b59f5097f9d24b60a0ae28f4ba2a

## Status

A Chrome Manifest V3 release candidate was built and inspected. This preparation did not upload a store item, submit a review, merge the branch, or deploy the web changes. Actual Chrome sign-in, job saving and live ATS form filling remain unverified in a clean browser profile.

## Changes

- Bump the extension manifest from 0.1.20 to 0.1.21 and use a factual, 97-character description.
- Remove the unused contextMenus permission and its unsupported listing claim.
- Reject password, OTP, credential, payment and other recognised sensitive fields before reading their current values in the direct scan path.
- Share field-safety rules across direct and fallback scanners; filter initial analysis and revision payloads, including previous answers.
- Preserve Chrome's serialized-function boundary and cross-frame field identifiers.
- Stop collecting broad surroundingText from form containers and extract static labels without reading value-bearing controls. This prevents a neighbouring sensitive editable field from entering another field's context. Tradeoff: AI receives less surrounding explanatory text.
- Apply the form_fill Persona purpose to the revision path, matching initial analysis.
- Explicitly disclose relevant form/profile transfer to ApplyMate and its configured AI provider in the form UI.
- Make only /privacy and /privacy/ public on the ordinary app host, retaining private-page and administrator-host routing.
- Correct the privacy policy's sign-out/token claim and document Chrome sync storage and actual optional all-site permission behaviour.
- Replace the old listing draft with the copy, permission reasons, data-use guidance, reviewer steps and final publisher checklist in CHROME_WEB_STORE_LISTING.md.

## Verification

| Check | Result |
| --- | --- |
| Extension TypeScript | Passed: apps/extension/node_modules/.bin/tsc --noEmit |
| Extension tests | Passed: 12 files, 72 tests, including 42 new scanner/safety tests |
| Middleware regression suite | Passed: 29 tests, including 9 new public-policy/private-route tests |
| Production extension build | Passed: Vite build and existing build.cjs postprocessing |
| Packaging | Passed: existing scripts/zip.mjs |
| JavaScript syntax | node --check passed for background, content, popup and sidepanel entrypoints |
| ZIP root | manifest.json directly at root |
| Manifest | V3; version 0.1.21; description 97 characters; no contextMenus |
| Entrypoints / icon references | All 9 referenced files present |
| Icons | 16, 32, 48 and 128 pixel PNGs present with matching dimensions |
| Package hygiene | 19 files; no node_modules, environment files, source maps, test files or .git |
| HTML remote script tags | None |
| Whitespace / patch check | git diff --check passed |

Tests were run without live backend calls. The middleware suite used the already-installed Vitest 3.2.7 runner with a temporary Node-only configuration mapping the web source alias; the full web suite, full web typecheck and full web production build were not run. No dependency or lockfile changes were made.

## Exact delivered archive

- Filename: ApplyMate-AI-0.1.21.zip
- Size: 252689 bytes
- SHA-256: 5329e0782008cba818cb89eadf5be93a1cb1da8ee84633e3b491009c7b9a1732

The existing post-build script embeds a fresh runtime build marker. Rebuilding the same source can therefore produce a different archive checksum. The checksum above identifies the archive prepared in this session.

## Confirmed external blockers and remaining release work

1. **Public policy deployment:** An anonymous GET to https://applymate.site/privacy followed a redirect to https://applymate.site/login?callbackUrl=%2Fprivacy. The final HTTP 200 was a login page, not the policy. This branch fixes the route in code; production must be redeployed and checked again.
2. **Google authentication:** The developer dashboard reached a Google “Verify that it’s you” screen for the existing account. Its publisher registration, existing item versions and listing state have not yet been inspected.
3. **Current screenshots:** Existing repository images have non-store dimensions and some show obsolete or signed-out UI. Capture at least one actual current screenshot at 1280 × 800 or 640 × 400.
4. **Reviewer access:** Provide a dedicated account with a fictional resume/profile and enough feature access, plus stable public test URLs. No test credentials have been fabricated or committed.
5. **Privacy operations:** The publisher must verify the monitored contact address, production AI processors, retention/deletion and human access practices, and a truthful Limited Use disclosure before certification. The existing contact is legal@applymate.ai and its mailbox has not been verified.
6. **PDF export:** Audited application-pack controls call a server-local exporter whose default path is D:\\My Jobs resume. This is not evidence of a browser download to an ordinary SaaS user's machine. Validate or correct/limit that feature before broad distribution; it was not refactored in this preparation.
7. **Permissions:** Optional HTTP/HTTPS access currently grants all sites together, not a single employer origin. This remains a review consideration; per-site permission redesign needs cross-origin iframe and navigation testing.
8. **Real browser acceptance:** Verify sign-in, save, account isolation, scan/revise/fill, file selection, denial/revocation of optional access and logout. Unit tests and static analysis are not a substitute for that acceptance run.

## Official requirements

Use the linked primary references in CHROME_WEB_STORE_LISTING.md. Registration, publisher identity, distribution, data certifications and review submission are separate from successful ZIP construction.
