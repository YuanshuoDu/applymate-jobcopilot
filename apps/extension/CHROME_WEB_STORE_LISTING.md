# ApplyMate AI — Chrome Web Store submission workbook

Prepared 2 November 2026 for extension version **0.1.22**. This is a release candidate and a review workbook, not evidence of Google approval or a completed submission. Use RELEASE_CHECKS.md for the exact tested build and unresolved publisher steps.

## 1. Store listing

- **Name:** ApplyMate AI
- **Short description:** Save jobs, organise applications and review AI-assisted form answers from your ApplyMate profile.
- **Suggested category:** Productivity, or the closest applicable category offered by the current dashboard.
- **Default language:** English
- **Website:** https://applymate.site
- **Privacy policy:** https://applymate.site/privacy — verify the production deployment before submission.
- **Support URL:** https://applymate.site/landing#contact — public support form; enter “Privacy / data request” in the message for privacy enquiries. This creates a support case, subject to service availability.
- **Support email:** A monitored publisher email is still needed if the dashboard requires an email field. The policy also retains the existing legal@applymate.ai address; mailbox operation has not been verified.

### Detailed description — ready to copy after final verification

Keep your job search organised while you browse.

ApplyMate AI connects supported job pages with your ApplyMate account, so you can save opportunities, compare them with your profile and prepare application answers from one side panel.

What you can do

- Save job details and the original link to your ApplyMate account.
- Review saved opportunities, application statuses and match information.
- Access your ApplyMate resume and profile alongside a job page.
- Review and download prepared application documents.
- Scan a compatible application form and generate suggested answers from your profile.
- Review and edit suggestions before choosing which values to fill.
- Choose your own local files when an application requires a document upload.

How it works

Sign in to ApplyMate, open a supported job page and use the extension popup or side panel. For form assistance, open Form Fill, allow the current site if requested, and select “Scan current page”. Review the suggested answers before applying them to the form.

An ApplyMate account and an internet connection are required. AI features use the ApplyMate service and its configured AI provider. Access and usage limits depend on your ApplyMate plan and available AI credits; additional usage can require a paid plan. Website compatibility varies by employer and form.

Your data and control

Form scanning reads supported field labels and existing values on the page you select. Relevant information is sent to ApplyMate and, when needed for an AI feature, its configured AI provider. Access to additional career websites is requested one site at a time. If an application form is embedded in another page, you can choose “Find embedded application frames” and then explicitly allow the relevant site. Without this optional discovery step, scanning covers the main page. You start each scan and choose which answers to fill.

This extension fills application fields for your review. You choose the final answers and submit the application yourself.

Website: https://applymate.site

Privacy policy: https://applymate.site/privacy

**Publisher note, not listing copy:** Confirm the review account's actual plan and AI access. Do not promise unlimited or fully free AI, unattended submission or universal ATS compatibility. Downloaded ZIPs contain the selected, signed-audited document revisions; edited or legacy unsigned documents require another audit. See RELEASE_CHECKS.md for PDF font/print fallback verification and other compatibility limits.

## 2. Privacy tab

### Single purpose

Help job seekers save job opportunities and prepare their applications using their ApplyMate profile, with user-reviewed form filling.

### Permission justifications

Paste each justification into its corresponding dashboard field.

| Permission | Justification |
| --- | --- |
| storage | Stores extension settings and account authentication state, and keeps account-scoped job caches, the selected resume and drafts available across the popup, side panel and background service worker. Settings and authentication state currently use Chrome sync storage; job caches and drafts use local storage. |
| sidePanel | Shows the job, profile, resume and form-review workspace alongside the job application page. |
| activeTab | Accesses the page selected by the user when they invoke the extension's job capture or form-assistance action. |
| scripting | Runs the packaged form scanner and filler in the selected tab and accessible frames after the user starts the feature. It also synchronises authentication with an ApplyMate dashboard tab. |
| tabs | Identifies the active job/application page, keeps the extension UI aligned with page navigation, and locates an authenticated ApplyMate dashboard tab for account synchronisation. |
| Listed job-board and ATS hosts | Reads supported job pages for job detection and saving and assists with compatible application forms on the declared hosts. |
| https://applymate.site/* | Connects to the ApplyMate API and synchronises the extension with the signed-in ApplyMate dashboard. |
| Optional https://*/* and http://*/* declarations | Allows the extension to request a concrete website origin at runtime for employer domains outside the built-in list. The UI requests only the displayed current site or an embedded application site individually selected by the user; it does not request the broad wildcard declarations together. |
| Optional webNavigation | Requested only after the user chooses “Find embedded application frames”. Reads the actual frame URLs and document identifiers in the current tab, including redirected/nested application frames, so the user can choose relevant site access and the extension can route scan/fill operations to the reviewed document. This frame map is local and is not used to collect browsing history or advertising data. |

The unused contextMenus permission was removed. Production packages do not include localhost or the previous Vercel preview host; localhost is added only by an explicit development build. Existing installations can retain an older all-sites grant until the user chooses the new removal control or revokes it in Chrome. Removal keeps the required built-in supported hosts available. Do not claim an update silently revokes earlier permissions.

### Remote code

The inspected extension contains no remote JavaScript loader, eval, new Function, or general interpreter for remotely supplied browser action plans. Executable scanner and filler logic is bundled in the uploaded package. The API returns job information, profile data and proposed form answers for user review.

On that basis, the intended answer for this package is **“No, I am not using remote code.”** Re-evaluate this answer if the package or its execution architecture changes. JSON alone does not establish compliance: Google's MV3 policy also prohibits interpreters of complex remote commands. Server-side AI processing of data is a different question from executing remote extension code.

### Data use — review against production before certifying

| Dashboard data category | Evidence and intended disclosure |
| --- | --- |
| Personally identifiable information | Yes: account name/email and profile/resume contact information. |
| Authentication information | Yes: ApplyMate sign-in credentials in transit and extension authentication tokens. |
| Website content | Yes: job descriptions, application form labels/options/placeholders and relevant existing form values. |
| Web history / browsing activity | Disclose the supported or user-selected page URLs processed for job and form features. The extension does not request the browser history API, but that does not make processed page URLs exempt from disclosure. |
| Location | Yes: user-provided location information, such as city, region or contact address, from the user's profile, resume and application answers is processed for resume editing and application form assistance. Public job locations are separately handled as website content. |
| Financial and payment information | Yes: user-provided salary expectations and compensation-related application answers are processed as part of the user's profile/Persona and form-assistance features. Public advertised salary ranges are separately handled as website content. This is a data-category recommendation based on the implemented fields, not a Google ruling specific to ApplyMate. |
| Health information | Yes: voluntarily supplied health or disability information in resumes, Persona facts or application answers can be processed by the form-assistance features. When included in an AI analysis or revision request, relevant information is sent to ApplyMate and the configured AI provider. |
| Other categories | Review actual form/profile content, diagnostics and production services. Do not bulk-select “no data collected”, and do not infer Gmail access in this extension from the separate web-app feature. |

Relevant data is sent over HTTPS to ApplyMate services and, for requested AI features, the configured AI provider. Chrome may synchronise extension settings and authentication state according to the user's Chrome settings. Signing out clears extension login state; it does not by itself revoke every previously issued token on the server.

The policy now explains supported versus configured AI providers, service-provider roles, actual deletion controls, scoped retention facts and Chrome/Google Limited Use requirements. The publisher must confirm the operational implementation of those commitments before checking the dashboard certifications. Support in code or a configured API key does not prove that every provider handles every user's data.

## 3. Reviewer test instructions

These are private review notes, not public store copy. Enter the dedicated account's credentials only in the dashboard's private Test instructions fields. Do not use a personal administrator account or commit credentials to this repository.

### Test access

- ApplyMate account: publisher-approved dedicated review email; provisioning is pending approval.
- Password: generated during approved provisioning and supplied privately, never in this repository.
- Support: https://applymate.site/landing#contact

The prepared provisioning script creates a normal account with a fictional resume, confirmed profile fields and a sample saved job, and disables notifications/usage sharing for that account. Creation was blocked by automatic approval review because the publisher has not approved the specific production account/email. No reviewer account or password has been created. After approval, verify its plan, AI credit availability and login before submitting these steps.

### Test steps

1. Open the installed extension and sign in with the review account.
2. Visit https://applymate.site/extension-review after the reviewed web deployment is live. It is a fictional Example Studio job and does not require a third-party job-board account. Open the popup, confirm the role and company, and save the role.
3. Open the side panel. Confirm that the saved role appears in Jobs.
4. On the same demonstration page, select Form Fill → Scan current page. The page includes ordinary application fields and a same-origin embedded form at /extension-review/frame.
5. On another employer origin, select “Allow this site” when needed, accept Chrome's prompt and scan again. To include embedded forms, choose “Find embedded application frames”, allow optional discovery, and explicitly allow only the relevant listed application site. Refusal leaves already-authorized pages usable and shows the coverage limit.
6. Review the suggestions, edit an answer and apply the selected answers to the page.
7. Confirm that values are filled but the form is not submitted. Choose a local file yourself if testing a document-upload field. Do not send a real job application.
8. Check the profile and prepared application documents. Only the selected versions with a valid, passing server audit can be downloaded as an application ZIP. Editing a document requires another audit. Use the clearly indicated browser-print fallback when necessary.
9. Verify permission refusal, removal of a previous all-sites grant, navigation during review, logout and account switching. Values must not be applied to a different or replaced page.

**Developer self-test:** Unzip the release archive, open chrome://extensions, enable Developer mode, choose Load unpacked and select the directory containing manifest.json. A ZIP file itself cannot be selected as an unpacked extension.

## 4. Visual assets

| Asset | Requirement / status |
| --- | --- |
| Extension/store icon | icons/icon128.png, 128 × 128 PNG, present in the package. |
| Screenshots | At least 1, up to 5. Use 1280 × 800, or 640 × 400; show the current working extension. |
| Prepared capture surface | /extension-review/preview.html uses actual extension components with clearly marked fictional, in-memory sample data; no backend, AI, permissions or downloads execute. |
| Screenshot 1 | Current popup with a fictional role and available actions. |
| Screenshot 2 | Current side-panel Jobs view with fictional saved applications. |
| Screenshot 3 | Current side-panel Profile view with fictional profile data. |
| Optional small promotional image | 440 × 280. Optional under the official page checked on 2 November 2026. |
| Optional marquee image | 1400 × 560. |

The older apps/web/public/screenshot-*.png images are not used. The prepared component-preview images are explicitly illustrative and do not prove Chrome installation or browser integration. Their UI is imported from the release source rather than redrawn. Re-capture in an installed Chrome extension if reviewers require the full browser context. No personal data, real credentials, generated AI interface mockups or unsupported completed-action claims belong in store screenshots.

## 5. Build and package

Use the repository's pinned pnpm version, **10.33.2**, and Node 20 or newer. This preparation used Node 24.22.1.

```bash
npx --yes pnpm@10.33.2 --filter @jobcopilot/extension... install --frozen-lockfile --ignore-scripts
npx --yes pnpm@10.33.2 --filter @jobcopilot/extension typecheck
npx --yes pnpm@10.33.2 --filter @jobcopilot/extension test
npx --yes pnpm@10.33.2 --filter @jobcopilot/extension build
npx --yes pnpm@10.33.2 --filter @jobcopilot/extension zip
```

Upload **apps/extension/release/ApplyMate-AI-0.1.22.zip**, containing manifest.json directly at its root. Upload the extension archive, not the whole repository or an outer submission-materials folder. If the dashboard already has version 0.1.22 or newer, increment the manifest version and rebuild; an update must have a higher version than the previously uploaded package. Minimum Chrome version is 116, matching sidePanel.open and document-bound routing support.

## 6. Publisher completion checklist

- [ ] Deploy the /privacy public-route fix and the reviewed policy text; confirm an anonymous request displays the policy itself, without a login redirect. A 200 login page is not a successful policy check.
- [ ] Verify the public support form is staffed, and confirm a monitored email if required by the dashboard.
- [ ] Verify production AI providers, user-facing limits, retention/deletion and human-access practices; complete an accurate Limited Use disclosure and all dashboard data-use certifications.
- [ ] Deploy and smoke-test the ordinary-user application ZIP flow and browser-print fallback. This release replaces the server-local D: exporter and rejects unsigned, changed or mismatched audit results.
- [ ] Test sign-in, job save, side-panel state, form scan/revise/fill, logout and optional-permission refusal in a clean Chrome profile.
- [ ] Review the prepared, correctly sized illustrative component screenshots and complete the installed-extension acceptance capture if required.
- [ ] Create/verify a dedicated reviewer account with a sample profile and sufficient feature access.
- [ ] Complete developer registration, 2-Step Verification and the publisher's own Trader/Non-Trader declaration.
- [ ] Upload the correct ZIP, fill Store Listing / Privacy / Distribution / Test instructions, and submit for review.
- [ ] If using deferred publishing, publish within the allowed staged period after approval.

## Official references checked 2 November 2026

- [Prepare the extension: ZIP, manifest and versions](https://developer.chrome.com/docs/webstore/prepare)
- [Image requirements](https://developer.chrome.com/docs/webstore/images)
- [Privacy fields and permission justifications](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [User data and Limited Use FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Manifest V3 remote-code requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- [Register a developer account](https://developer.chrome.com/docs/webstore/register)
- [Official 2026 confirmation of the $5 new-publisher registration fee](https://developer.chrome.com/blog/cws-role-expansion-developer-dashboard)
- [Trader verification FAQ](https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq)
- [Publish and deferred publishing](https://developer.chrome.com/docs/webstore/publish)
- [Review process](https://developer.chrome.com/docs/webstore/review-process)
- [Current Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api)
