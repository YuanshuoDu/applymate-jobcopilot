# Chrome Web Store release preparation — 0.1.22

- Prepared 2 November 2026
- Branch: fix/chrome-web-store-release
- Issue: #1072
- PR: https://github.com/YuanshuoDu/applymate-jobcopilot/pull/1071
- Base: e57977dc8ad0b59f5097f9d24b60a0ae28f4ba2a

## Evidence boundary

This file records source changes and local verification. It is not evidence of a Google upload, review approval or publication. Record subsequent hosting and browser checks separately against their actual commit and URL.

The runtime did not permit opening Chrome's extension-management page. No alternative installation method was used. Installed-extension login, native permission prompts, actual ATS filling and the native file picker still require acceptance in an installed Chrome profile. The supplied acceptance checklist makes that remaining work explicit.

## Changes

### Form access and account isolation

- Reject recognised password, OTP, credential and payment-secret fields before reading values. Labels exclude editable subtrees; editor reads exclude nested controls.
- Request optional access to a concrete protocol, host and port. Request optional webNavigation only for the explicit embedded-frame discovery action.
- Discover actual nested/redirected frame URLs, then let users select each relevant additional site. Main-page-only and partial coverage are visible.
- Bind scan, read, fill and upload to the reviewed documentId. Navigation and document replacement invalidate old answers.
- Recheck live sensitivity, type, visibility and disabled state before reads/writes. Remove same-origin iframe recursion and schema-free field-ID fallback from execution.
- Restrict initial/revised AI results to the safe scanned field IDs; preserve unmodified reviewed answers.
- Restrict the logout bridge to the real dashboard and same-window messages.
- Reset form sessions on account changes; reject stale Persona results.
- Restrict API/background authentication recovery to the same nonempty normalised email and API base URL. First connection requires confirmation of the synced account and a new action.
- Scope saved-job caches and pending work by account. Reject stale A→B and A→B→A results without deleting the new account's pending operation.
- Disclose form/profile transfers, including voluntarily provided location, salary and health/disability information.

### Browser application documents

- POST /api/jobs/:id/application-pack now generates a browser-downloadable ZIP in memory, replacing server-local Windows filesystem export.
- GET on the same route returns an escaped, script-free UTF-8 print view with private caching and restrictive CSP.
- Both methods require job/document ownership, exact selected final IDs and updatedAt values, and the latest passing server-signed audit.
- A versioned HMAC receipt binds the complete result, account, job and document versions using the existing server authentication secret.
- Ordinary activity writes refuse the reserved [Auditor] namespace. Unsigned, altered, cross-account, cross-job or stale records cannot authorize downloads, printing or audit fixes.
- /export-local remains only as a ZIP compatibility alias. No child_process, host-browser or server-folder export path remains.
- Final-selection metadata preserves document revision; optimistic concurrency rejects simultaneous edits.
- PDFs retain contact links, custom resume content and full cover-letter text. Duplicate signatures and automatic word hyphenation are removed.
- Unsupported standard-font characters return an explicit 422. The real browser-print entry preserves Unicode and uses device fonts.
- Web/extension actions download or open the audited print view; re-audit targets the exact selected documents.

### Public materials and build

- Only precise privacy and review-demo paths are public; private routes and administrator-host handling remain protected.
- The fictional Example Studio review page contains ordinary fields and a same-origin embedded form, with no real application submission endpoint.
- The bilingual policy explains actual AI integrations, configured recipients, service roles, browser storage, retention/deletion limits, analytics and Limited Use.
- The public support form is the primary privacy contact. The additional legal mailbox has not been operationally verified.
- A separate preview imports actual popup/side-panel components with fictional in-memory fixtures. Login, AI, persistent writes, permissions, downloads, printing, external navigation and network calls are disabled.
- Manifest version/version_name is 0.1.22; minimum Chrome is 116. Production removes unused contextMenus, localhost and the old Vercel host. Only development builds restore documented loopback origins.
- The default extension test command now includes source-adjacent security tests.
- Stabilized the translation callback across ordinary renders to stop the Profile loading effect from repeatedly fetching data. A real React root/effect regression covers asynchronous result updates, parent renders, unchanged-language polling and language changes.
- Corrected the popup action title/subtitle layout. The isolated preview uses the original icon bytes and the actual 360-pixel popup width.

## Verification

| Check | Result |
| --- | --- |
| Extension TypeScript | Passed: tsc --noEmit --pretty false |
| All extension tests | Passed: 24 files, 210 tests |
| Web targeted release regressions | Passed: 22 files, 164 tests |
| Final privacy copy | Existing 5 privacy tests rerun after the final bilingual disclosure text |
| Full Web TypeScript | Passed: tsc --noEmit --incremental false --pretty false |
| Production extension build | Vite production build and build.cjs postprocessing passed |
| Development build | Passed; both documented localhost origins present only in development |
| Production manifest | MV3, 0.1.22, Chrome 116; no contextMenus, localhost or old Vercel host |
| Separate component preview | Build passed with disabled API/platform adapters |
| JavaScript syntax | All 10 emitted JS files passed node --check |
| Module graph | Relative imports resolve inside the package; background/content have no top-level module syntax |
| Built service worker | Initialized in a network-disabled VM; 8 listeners registered. Not a native Chrome install |
| ZIP and references | CRC verified; manifest.json at root; all 9 referenced entrypoints/assets present |
| Icons | PNG dimensions verified: 16, 32, 48 and 128 pixels |
| Package hygiene | 19 files plus 4 directories; no dependencies, environment files, maps, tests or preview fixtures |
| Remote script tags | None in emitted extension HTML |
| Lockfile | Changes stashed; test-script-only edit checked with pinned pnpm 10.33.2 frozen install; no lockfile/dependency changes; changes restored |
| Whitespace | git diff --check passed |

Tests use mocked network/Chrome APIs and database fixtures, without production AI calls or real applications. The web suite covers ZIP/print routes, legacy alias, audit read/write/apply, final selection, reserved activity names, signatures, renderers, browser helpers, final-confirm UI, JobsPage, middleware, privacy and the review demo.

Fictional PDF validation generated actual Resume.pdf and CoverLetter.pdf, each one-page A4. Text extraction checked 46 resume text fields and the complete cover letter with one signature. A second renderer confirmed no clipping or overlap. Browser printing uses a generic document layout and depends on device fonts.

## Exact archive

- Filename: ApplyMate-AI-0.1.22.zip
- Size: 259612 bytes
- SHA-256: 2424fc3ae8c062865f86f6f09f8c56929df296a38c67c8a934924a1acd53587c
- Entries: 23, comprising 19 files and 4 directories.

The existing build process embeds a fresh content-runtime marker. Rebuilding identical source can change the checksum; the value above identifies the delivered archive.

## Compatibility and remaining acceptance

- Legacy unsigned receipts and records signed with a rotated authentication secret require another independent audit.
- Standard PDF fonts do not cover every script. Use the audited print view and inspect glyphs when ZIP generation reports unsupported text.
- Restricted/sandboxed, about:blank, srcdoc and blob frames are not guaranteed targets. Refresh discovery and rescan after navigation.
- Old all-sites grants remain until explicitly removed. Required built-in hosts remain available.
- Component screenshots show actual UI and illustrative data; they do not prove native permissions, live AI or actual Chrome installation.
- No production reviewer account or usable credentials were created. Automatic approval rejected creation because the exact production account/email had not been explicitly approved. A guarded provisioning script and fictional data are prepared outside this repository.

## Hosting, CI and publisher completion

Before submission, verify the production privacy page, public demonstration, support contact and ordinary-account download flow. A preview build is not proof that the production domain changed. Keep deployment evidence against exact commit IDs.

An earlier CI run for 9512544 failed an unrelated Worker PostgreSQL/Redis durable-child-wait recovery test: [run 41480976213, job 125398862393](https://github.com/YuanshuoDu/applymate-jobcopilot/actions/runs/41480976213/job/125398862393). Worker/CI files were unchanged from e57977d. This does not establish that the exact base had failing CI. The test was not weakened or changed here. The subsequent code commit 7406321 passed CI run 41490652604, including the durable child-wait restart step. Record checks for any later visual-only follow-up separately; local release tests alone do not establish full-repository CI success.

Publisher steps remain Google authentication, dedicated review access and sufficient AI limits, installed Chrome acceptance, contact verification, developer registration/security requirements, accurate data certifications, Trader/Non-Trader information and final store submission. The listing workbook explicitly covers Location, personal salary expectations and voluntarily supplied Health information.
