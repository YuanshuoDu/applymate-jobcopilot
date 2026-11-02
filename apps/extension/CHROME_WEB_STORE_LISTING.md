# ApplyMate AI — Chrome Web Store submission workbook

Prepared 2 November 2026 for extension version **0.1.21**. This is a release candidate and a review workbook, not evidence of Google approval or a completed submission. Resolve the publisher checklist below before submitting.

## 1. Store listing

- **Name:** ApplyMate AI
- **Short description:** Save jobs, organise applications and review AI-assisted form answers from your ApplyMate profile.
- **Suggested category:** Productivity, or the closest applicable category offered by the current dashboard.
- **Default language:** English
- **Website:** https://applymate.site
- **Privacy policy:** https://applymate.site/privacy — deploy and verify the public-route fix first.
- **Support contact:** Use a publisher-confirmed, monitored address. The existing policy says legal@applymate.ai; its operation has not been verified.

### Detailed description — ready to copy after final verification

Keep your job search organised while you browse.

ApplyMate AI connects supported job pages with your ApplyMate account, so you can save opportunities, compare them with your profile and prepare application answers from one side panel.

What you can do

- Save job details and the original link to your ApplyMate account.
- Review saved opportunities, application statuses and match information.
- Access your ApplyMate resume and profile alongside a job page.
- Scan a compatible application form and generate suggested answers from your profile.
- Review and edit suggestions before choosing which values to fill.
- Choose your own local files when an application requires a document upload.

How it works

Sign in to ApplyMate, open a supported job page and use the extension popup or side panel. For form assistance, open Form Fill and select “Scan current page”. Review the suggested answers before applying them to the form.

An ApplyMate account and an internet connection are required. AI features use the ApplyMate service and its configured AI provider. Website compatibility varies by employer and form.

Your data and control

Form scanning reads supported field labels and existing values on the page you select. Relevant information is sent to ApplyMate and, when needed for an AI feature, its configured AI provider. Optional access to all HTTP and HTTPS websites is available for additional career sites and embedded application forms. Granting it is optional; you start each form scan.

This extension fills application fields for your review. You choose the final answers and submit the application yourself.

Website: https://applymate.site

Privacy policy: https://applymate.site/privacy

**Publisher note, not listing copy:** Confirm production AI access, credit limits and pricing. Disclose material paid restrictions; do not claim unlimited or fully free AI without checking the actual product. Do not advertise unattended submission, universal ATS compatibility or automatic download to a user's local D: drive as extension capabilities.

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
| Optional https://*/* and http://*/* | Supports user-initiated form assistance on employer domains and embedded ATS frames outside the built-in host list. The current implementation requests all HTTP/HTTPS origins together when the user selects Allow access; it is not a per-site grant. Form scanning is initiated by the user on their selected tab. |

The unused contextMenus permission was removed. The optional broad host grant remains a permission-review consideration; explain the actual implementation accurately instead of claiming it is scoped to one site.

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
| Other categories | Review actual form/profile content, diagnostics and production services. Do not bulk-select “no data collected”, and do not infer Gmail access in this extension from the separate web-app feature. |

Relevant data is sent over HTTPS to ApplyMate services and, for requested AI features, the configured AI provider. Chrome may synchronise extension settings and authentication state according to the user's Chrome settings. Signing out clears extension login state; it does not by itself revoke every previously issued token on the server.

The publisher must confirm actual processors, server retention/deletion, human access practices and Limited Use compliance before checking the dashboard certifications. The previous draft's unsupported claim about human-access exceptions has been removed. The policy should contain a truthful Chrome Web Store Limited Use disclosure; do not add an operational commitment that has not been verified.

## 3. Reviewer test instructions

These are private review notes, not public store copy. Replace all bracketed placeholders with verified information before using them. Do not use a personal administrator account or commit reviewer credentials to this repository.

### Test access

- ApplyMate account: [DEDICATED REVIEW ACCOUNT EMAIL]
- Password: [ENTER ONLY IN THE DEVELOPER DASHBOARD TEST ACCESS FIELD]
- Support: [VERIFIED SUPPORT EMAIL]

The review account contains a sample resume and profile and has access to the AI features used in these steps.

### Test steps

1. Open the installed extension and sign in with the review account.
2. Visit [VERIFIED PUBLIC JOB DETAIL URL WITHOUT A THIRD-PARTY LOGIN REQUIREMENT]. Open the popup, confirm the detected role and company, and save the role.
3. Open the side panel. Confirm that the saved role appears in Jobs.
4. Open [SAFE DEMONSTRATION APPLICATION FORM URL]. Select Form Fill → Scan current page.
5. If additional website access is needed, select Allow access, accept Chrome's permission prompt and scan again.
6. Review the suggestions, edit an answer and apply the selected answers to the page.
7. Confirm that values are filled but the form is not submitted. Choose a local file yourself if testing a document-upload field. Do not send a real job application.
8. Verify that password, OTP, payment and credential fields are excluded from form suggestions.

**Developer self-test:** Unzip the release archive, open chrome://extensions, enable Developer mode, choose Load unpacked and select the directory containing manifest.json. A ZIP file itself cannot be selected as an unpacked extension.

## 4. Visual assets

| Asset | Requirement / status |
| --- | --- |
| Extension/store icon | icons/icon128.png, 128 × 128 PNG, present in the package. |
| Screenshots | At least 1, up to 5. Use 1280 × 800, or 640 × 400; show the current working extension. |
| Suggested screenshot 1 | Supported job detail page with the popup showing the role and save action. |
| Suggested screenshot 2 | Signed-in side panel with saved sample jobs and match information. |
| Suggested screenshot 3 | Reviewable form answers beside a safe application form, before manual submission. |
| Optional small promotional image | 440 × 280. Optional under the official page checked on 2 November 2026. |
| Optional marquee image | 1400 × 560. |

The repository's existing apps/web/public/screenshot-*.png images are not release evidence: they have other dimensions and include old or signed-out interfaces. Retake screenshots using fictional sample profile data, without real credentials or personal records. Do not use generated UI mockups as screenshots of working functionality.

## 5. Build and package

Use the repository's pinned pnpm version, **10.33.2**, and Node 20 or newer. This preparation used Node 24.22.1.

```bash
npx --yes pnpm@10.33.2 --filter @jobcopilot/extension... install --frozen-lockfile --ignore-scripts
npx --yes pnpm@10.33.2 --filter @jobcopilot/extension typecheck
npx --yes pnpm@10.33.2 --filter @jobcopilot/extension test
npx --yes pnpm@10.33.2 --filter @jobcopilot/extension build
npx --yes pnpm@10.33.2 --filter @jobcopilot/extension zip
```

Upload **apps/extension/release/ApplyMate-AI-0.1.21.zip**, containing manifest.json directly at its root. Upload the extension archive, not the whole repository or an outer submission-materials folder. If the dashboard already has version 0.1.21 or newer, increment the manifest version and rebuild; an update must have a higher version than the previously uploaded package.

## 6. Publisher completion checklist

- [ ] Deploy the /privacy public-route fix and the reviewed policy text; confirm an anonymous request displays the policy itself, without a login redirect. A 200 login page is not a successful policy check.
- [ ] Confirm legal@applymate.ai is monitored, or replace it with the real privacy/support address.
- [ ] Verify production AI providers, user-facing limits, retention/deletion and human-access practices; complete an accurate Limited Use disclosure and all dashboard data-use certifications.
- [ ] Confirm the ordinary-user PDF/download flow. Existing audited-pack export calls a server-local path defaulting to D:\\My Jobs resume; this has not been verified for public SaaS users. Fix or visibly limit that feature before broad distribution.
- [ ] Test sign-in, job save, side-panel state, form scan/revise/fill, logout and optional-permission refusal in a clean Chrome profile.
- [ ] Capture at least one current, correctly sized screenshot.
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
