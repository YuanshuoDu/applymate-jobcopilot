# ApplyMate API Reference

This document covers the API routes under `apps/web/src/app/api`.

Base URL examples use:

```bash
BASE_URL=http://localhost:3000
TOKEN=eyJ... # extension token, when using Bearer auth instead of a browser session
```

## Table of Contents

- [Authentication](#authentication)
- [Standard Responses](#standard-responses)
- [Auth](#auth)
- [Me and Settings](#me-and-settings)
- [Jobs](#jobs)
- [Resume](#resume)
- [Cover Letter](#cover-letter)
- [AI](#ai)
- [Agent](#agent)
- [Search](#search)
- [Gmail](#gmail)
- [Dashboard](#dashboard)
- [Apply Results](#apply-results)
- [Notifications](#notifications)
- [Activity](#activity)
- [Admin](#admin)
- [Directions](#directions)
- [Market and Salary](#market-and-salary)
- [Curl Examples](#curl-examples)

## Authentication

Most product APIs call `requireAuth()`.

| Auth type | How to call | Applies to |
| --- | --- | --- |
| Session cookie | Browser-authenticated request, or `curl -b cookie.txt ...` | Web app APIs |
| Bearer token | `Authorization: Bearer $TOKEN` | Extension-compatible APIs backed by `requireAuth(req)` |
| Public | No authentication required | Registration, forgot password, credentials extension token, NextAuth handlers |
| Gmail OAuth | Session auth plus a linked Google account with Gmail scopes | Gmail routes |

`requireAuth(req)` accepts a `Bearer` token and falls back to the NextAuth session. `requireAuth()` without `req` requires the NextAuth session.

## Standard Responses

Helpers in `apps/web/src/lib/api-helpers.ts` return JSON:

| Helper | Shape |
| --- | --- |
| `ok(data, status = 200)` | The provided JSON payload |
| `err(message, status = 400)` | `{ "error": "message" }` |
| Unauthorized | `{ "error": "Unauthorized" }` with status `401` |

Common status codes: `200`, `201`, `400`, `401`, `403`, `404`, `409`, `422`, `429`, `500`, `501`, `502`.

The `Curl` column points to a full example in [Curl Examples](#curl-examples). The path in the example can be swapped for another row with the same method/auth pattern.

## Auth

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/auth/register` | Public | JSON `{ email, password, name? }`; password min 8 chars | Created user without password; `201`; `409` if email exists | [C01](#c01-register) |
| `POST` | `/api/auth/forgot-password` | Public | JSON `{ email }` | `{ ok: true }`; `400` invalid email | [C02](#c02-forgot-password) |
| `POST` | `/api/auth/extension-token` | Public credentials | JSON `{ email, password }` | `{ token, user: { id, email, name, plan } }`; `401` invalid credentials | [C03](#c03-create-extension-token) |
| `GET` | `/api/auth/me/extension-token` | Session cookie | none | `{ token, user: { id, email, name, plan } }`; `401`, `404` | [C04](#c04-session-extension-token) |
| `GET/POST` | `/api/auth/[...nextauth]` | NextAuth public/session | NextAuth provider payloads | NextAuth sign-in, callback, sign-out, session responses | [C05](#c05-nextauth-session) |

## Me and Settings

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/me` | Session cookie | none | User profile `{ id, email, name, image, plan, phone, location, linkedin, github, preferences, createdAt, onboardedAt, onboardingGoals }` | [C06](#c06-get-profile) |
| `PATCH` | `/api/me` | Session cookie | JSON subset of `{ name, phone, location, linkedin, github, preferences, image }` | Updated user; `400` if no valid fields | [C07](#c07-update-profile) |
| `GET` | `/api/me/accounts` | Session cookie | none | `{ accounts: string[] }` connected providers | [C08](#c08-list-connected-accounts) |
| `DELETE` | `/api/me/accounts` | Session or Bearer | JSON `{ provider }` | `{ disconnected: provider }`; `400` missing provider | [C09](#c09-disconnect-account) |
| `GET` | `/api/me/ai-budget` | Session or Bearer | none | `{ used, limit, remaining, hasBudget }` | [C10](#c10-ai-budget) |
| `GET` | `/api/me/ai-config` | Session cookie | none | Masked `{ keys, features }` AI settings | [C11](#c11-get-ai-config) |
| `POST` | `/api/me/ai-config` | Session or Bearer | User AI settings `{ keys?, features? }` | `{ saved: true }`; `400` invalid provider/model | [C12](#c12-save-ai-config) |
| `POST` | `/api/me/ai-test` | Session or Bearer | JSON `{ provider, model }` | `{ ok: true }` or `{ ok: false, error }` | [C13](#c13-test-ai-config) |
| `GET` | `/api/me/api-keys` | Session or Bearer | none | `{ hasAdzuna, hasRapidapi }`, never raw secrets | [C14](#c14-get-api-keys) |
| `POST` | `/api/me/api-keys` | Session or Bearer | JSON `{ adzunaAppId?, adzunaAppKey?, rapidapiKey? }` | `{ hasAdzuna, hasRapidapi }`; `400` no keys | [C15](#c15-save-api-keys) |
| `PUT` | `/api/me/api-keys` | Session or Bearer | Same as `POST /api/me/api-keys` | Same as POST | [C15](#c15-save-api-keys) |
| `DELETE` | `/api/me/delete` | Session cookie | JSON confirmation `{ email }` | `{ message: "Account permanently deleted" }`; `400`, `404` | [C16](#c16-delete-account) |
| `PATCH` | `/api/me/onboarding` | Session or Bearer | JSON onboarding fields, including `onboardingGoals` | `{ ok: true }` | [C17](#c17-save-onboarding) |
| `PATCH` | `/api/me/password` | Session cookie | JSON `{ currentPassword, newPassword }` | `{ message: "Password updated" }`; `400` invalid/current mismatch | [C18](#c18-change-password) |
| `GET` | `/api/me/persona` | Session or Bearer | none | `{ persona }` synthesized from profile and preferences | [C19](#c19-get-persona) |
| `GET` | `/api/me/persona/fields` | Session or Bearer | none | `{ fields: PersonaField[] }` | [C20](#c20-list-persona-fields) |
| `POST` | `/api/me/persona/fields` | Session or Bearer | JSON `{ fields: [{ key, label?, value, source?, category? }] }` | `{ fields }` merged by key | [C21](#c21-upsert-persona-fields) |
| `DELETE` | `/api/me/persona/fields` | Session or Bearer | JSON `{ key }` | `{ ok: true }` | [C22](#c22-delete-persona-field) |

## Jobs

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/jobs` | Session or Bearer | Query `status?, source?, q?, finalResumeId?, page?, pageSize?` | `{ jobs, total, page, pageSize }` | [C23](#c23-list-jobs) |
| `POST` | `/api/jobs` | Session or Bearer | JSON `{ company, role, location?, url?, description?, salary?, source?, score?, status?, logo? }` | Created job; `201`; creates activity | [C24](#c24-create-job) |
| `GET` | `/api/jobs/:id` | Session cookie | path `id` | Job owned by user; `404` if not found | [C25](#c25-get-job) |
| `PATCH` | `/api/jobs/:id` | Session cookie | JSON updatable job fields | Updated job; `404` if not found | [C26](#c26-update-job) |
| `DELETE` | `/api/jobs/:id` | Session cookie | path `id` | `{ deleted: true }` | [C27](#c27-delete-job) |
| `POST` | `/api/jobs/:id/apply` | Session or Bearer | path `id` | `{ applied: true }`; marks job applied and logs activity | [C28](#c28-mark-job-applied) |
| `GET` | `/api/jobs/:id/apply-results` | Session or Bearer | path `id` | `{ results }` for application attempts | [C29](#c29-job-apply-results) |
| `PATCH` | `/api/jobs/:id/assign` | Session or Bearer | JSON assignment fields, typically `resumeId?`, `coverLetterId?`, `directionId?` | Updated job | [C30](#c30-assign-job-assets) |
| `POST` | `/api/jobs/:id/auto-apply` | Session or Bearer | path `id`; job must have URL | `{ queued: true, taskId }`; `409` if already applied/in progress | [C31](#c31-queue-auto-apply) |
| `GET` | `/api/jobs/:id/cover-letters` | Session or Bearer | path `id` | Cover letters for job | [C32](#c32-list-job-cover-letters) |
| `POST` | `/api/jobs/:id/cover-letters` | Session or Bearer | JSON `{ content, resumeId?, tone?, isFinal?, origin? }` | Created cover letter; `201` | [C33](#c33-create-job-cover-letter) |
| `POST` | `/api/jobs/:id/cover-letters/generate` | Session or Bearer | JSON `{ resumeId, tone?, language?, recipientName? }` | Generated and saved cover letter with `_model`; `201` | [C34](#c34-generate-job-cover-letter) |
| `POST` | `/api/jobs/:id/enrich` | Session or Bearer | path `id` | Enriched job data, or error if not found | [C35](#c35-enrich-job) |
| `POST` | `/api/jobs/:id/tailor-resume` | Session or Bearer | JSON `{ resumeId }` | `{ adaptedResumeId, changes }` | [C36](#c36-tailor-resume-for-job) |

## Resume

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/resume` | Session cookie | none | Resume summaries ordered default first | [C37](#c37-list-resumes) |
| `POST` | `/api/resume` | Session cookie | JSON `{ name, content, templateId?, isDefault?, directionId?, kind?, origin? }` | Created resume; `201` | [C38](#c38-create-resume) |
| `GET` | `/api/resume/:id` | Session cookie | path `id` | Resume; `404` if not owned | [C39](#c39-get-resume) |
| `PATCH` | `/api/resume/:id` | Session cookie | JSON resume fields, including `name`, `content`, `templateId`, `isDefault`, `directionId`, `kind`, `origin` | Updated resume | [C40](#c40-update-resume) |
| `DELETE` | `/api/resume/:id` | Session cookie | path `id` | `{ deleted: true }` | [C41](#c41-delete-resume) |
| `GET` | `/api/resume/:id/versions` | Session cookie | path `id` | Resume versions | [C42](#c42-list-resume-versions) |
| `POST` | `/api/resume/:id/versions` | Session cookie | JSON `{ versionId }` | Restored/updated resume from version | [C43](#c43-restore-resume-version) |
| `GET` | `/api/resume/default` | Session or Bearer | Query `directionId?` | `{ content }` default or fallback resume; `404` none | [C44](#c44-default-resume) |
| `POST` | `/api/resume/intake` | Session or Bearer | Intake JSON from resume wizard | Created or updated resume intake artifacts | [C45](#c45-resume-intake) |
| `POST` | `/api/resume/parse` | Session or Bearer | Multipart form field `file` PDF/DOCX max 5 MB | `{ content }` parsed resume JSON; `429` rate limit | [C46](#c46-parse-resume) |

## Cover Letter

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `PATCH` | `/api/cover-letters/:id` | Session or Bearer | JSON cover letter fields such as `{ content?, tone?, isFinal? }` | Updated cover letter; `404` if not found | [C47](#c47-update-cover-letter) |
| `DELETE` | `/api/cover-letters/:id` | Session or Bearer | path `id` | Deleted cover letter response; `404` if not found | [C48](#c48-delete-cover-letter) |

## AI

All AI routes require auth plus rate limiting through `prepareAiRoute` unless noted.

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/ai/cover-letter` | Session or Bearer | JSON `{ resumeContent, jobTitle, jobCompany, jobDescription?, tone?, language?, recipientName?, jobId?, resumeId? }` | `{ coverLetter, coverLetterId?, _model }` | [C49](#c49-ai-cover-letter) |
| `POST` | `/api/ai/field-suggest` | Session or Bearer | JSON field context and persona data | Suggested values for form fields | [C50](#c50-ai-field-suggest) |
| `POST` | `/api/ai/form-fill` | Session or Bearer | JSON `{ fields: FormField[], persona, jobContext? }`; max 60 fields | `{ fields: [{ fieldId, value, confidence, reasoning, skip, personaRelevant }] }` | [C51](#c51-ai-form-fill) |
| `POST` | `/api/ai/form-fill/revise` | Session or Bearer | JSON `{ fields, previousFill, persona, instruction, jobContext? }` | `{ fields }` revised values | [C52](#c52-ai-form-fill-revise) |
| `POST` | `/api/ai/interview-prep` | Session or Bearer | JSON `{ jobTitle, jobCompany, jobDescription?, resumeContent? }` | Interview preparation JSON with `_model` | [C53](#c53-ai-interview-prep) |
| `POST` | `/api/ai/score` | Session or Bearer | JSON `{ resumeContent?, jobTitle?, jobCompany?, jobDescription?, keySkills? }`; requires `jobTitle` or `jobDescription` | Score object with keywords, section matches, gaps, `_model` | [C54](#c54-ai-score) |
| `POST` | `/api/ai/suggest` | Session or Bearer | JSON `{ resumeContent, jobDescription?, jobTitle?, jobCompany? }` | `{ suggestions, _model }` | [C55](#c55-ai-suggest) |
| `POST` | `/api/ai/translate` | Session or Bearer | JSON `{ text, targetLang?, sourceLang? }`; target default `zh` | `{ translated, sourceLang, targetLang, _model }` | [C56](#c56-ai-translate) |

## Agent

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/agent` | Session cookie | none | Agent config or defaults | [C57](#c57-get-agent-config) |
| `PATCH` | `/api/agent` | Session cookie | JSON agent config fields | Updated config | [C58](#c58-update-agent-config) |
| `POST` | `/api/agent/answer` | Session or Bearer | JSON `{ questionId, answer }` | `{ answered: true, questionId, answer }`; `409` if already answered | [C59](#c59-answer-agent-question) |
| `POST` | `/api/agent/chat` | Session or Bearer | JSON `{ messages, role?, jobId?, context? }` | Streaming or text chat response, depending route branch | [C60](#c60-agent-chat) |
| `GET` | `/api/agent/history` | Session or Bearer | Query `jobId?`, pagination filters | Agent history records | [C61](#c61-agent-history) |
| `GET` | `/api/agent/roles` | Session cookie | none | Role configs | [C62](#c62-list-agent-roles) |
| `PATCH` | `/api/agent/roles` | Session or Bearer | JSON bulk role config patch | Updated roles | [C63](#c63-update-agent-roles) |
| `GET` | `/api/agent/roles/:role` | Session or Bearer | path role | Role config or `null` | [C64](#c64-get-agent-role) |
| `PATCH` | `/api/agent/roles/:role` | Session or Bearer | JSON role config | Updated role | [C65](#c65-update-agent-role) |
| `GET` | `/api/agent/roles/custom` | Session cookie | none | Custom agent roles | [C66](#c66-list-custom-agent-roles) |
| `POST` | `/api/agent/roles/custom` | Session or Bearer | JSON `{ name, description?, systemPrompt?, provider?, model?, apiKey? }` | Created custom agent role | [C67](#c67-create-custom-agent-role) |
| `PATCH` | `/api/agent/roles/custom/:id` | Session or Bearer | JSON custom role fields | Updated custom agent | [C68](#c68-update-custom-agent-role) |
| `DELETE` | `/api/agent/roles/custom/:id` | Session or Bearer | path `id` | `{ deleted: id }` | [C69](#c69-delete-custom-agent-role) |
| `GET` | `/api/agent/run` | Session or Bearer | Query task/run filters | Agent run status/log data | [C70](#c70-agent-run-status) |
| `POST` | `/api/agent/scout` | Session or Bearer | JSON scout criteria | `{ queued: true }` | [C71](#c71-queue-scout) |

## Search

Search routes require auth. Provider-backed routes may return `501` if API keys are missing and `502` for upstream failures.

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/search/unified` | Session or Bearer | Query `q`, plus optional `location`, `page`, `pageSize`, `sources`, provider filters | Unified `{ jobs, total, meta }`; may include cache hit metadata | [C72](#c72-unified-search) |
| `GET` | `/api/adzuna/search` | Session or Bearer | Query `q`, optional `location`, `page` | `{ jobs, total, page }` | [C73](#c73-adzuna-search) |
| `GET` | `/api/ats/search` | Session or Bearer | Query search parameters for ATS discovery | Normalized jobs/search response | [C74](#c74-ats-search) |
| `GET` | `/api/bundesagentur/search` | Session or Bearer | Query `q?`, `location?`, `page?`; requires one of `q` or `location` | `{ jobs, total, page }` | [C75](#c75-bundesagentur-search) |
| `GET` | `/api/careerjet/search` | Session or Bearer | Query `q?`, `location?`, `page?`; requires one of `q` or `location` | `{ jobs, total, pages, page }` | [C76](#c76-careerjet-search) |
| `GET` | `/api/indeed/search` | Session or Bearer | Query `q`, optional `location`, `page`, `token` | `{ jobs, total, page, ... }` | [C77](#c77-indeed-search) |
| `GET` | `/api/internships/search` | Session or Bearer | Query provider filters; RapidAPI key required | `{ jobs, total, page }` | [C78](#c78-internships-search) |
| `GET` | `/api/irishjobs/search` | Session or Bearer | Query `q`, optional `location`, `page` | `{ jobs, total, page }`, RSS fallback possible | [C79](#c79-irishjobs-search) |
| `GET` | `/api/jobicy/search` | Session or Bearer | Query `q?`, remote/job category filters | `{ jobs, total, page }` | [C80](#c80-jobicy-search) |
| `GET` | `/api/jsearch/search` | Session or Bearer | Query `q`, optional `page`; RapidAPI key required | `{ jobs, total, page }` | [C81](#c81-jsearch-search) |
| `GET` | `/api/linkedin/search` | Session or Bearer | Query `q`, optional `location`, `page`; RapidAPI key required | `{ jobs, total, page }` | [C82](#c82-linkedin-search) |
| `GET` | `/api/mantiks/company` | Session or Bearer | Query `website`; Mantiks key required | `{ jobs, total, website }` | [C83](#c83-mantiks-company) |
| `GET` | `/api/mantiks/search` | Session or Bearer | Query `q`, optional filters; Mantiks key required | Company/job search response | [C84](#c84-mantiks-search) |
| `GET` | `/api/reed/search` | Session or Bearer | Query `q?`, `location?`, `page?`; requires one of `q` or `location` | `{ jobs, total, page }` | [C85](#c85-reed-search) |
| `GET` | `/api/remotive/search` | Session or Bearer | Query `q?`, category/company filters | `{ jobs, total }` | [C86](#c86-remotive-search) |
| `GET` | `/api/xing/search` | Session or Bearer | Query `q`, optional `location`, `page`, `token`; RapidAPI key required | `{ jobs, total, page, ... }` | [C87](#c87-xing-search) |

## Gmail

Gmail routes require user auth. Routes that call Gmail also require a linked Google account and valid Gmail OAuth scopes.

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/gmail/ai-reply` | Session or Bearer | JSON `{ emailBody, subject, senderName, senderEmail, tag, jobId? }`; requires `subject` or `emailBody` | `{ reply, hrEmail, hrName }` | [C88](#c88-gmail-ai-reply) |
| `GET` | `/api/gmail/check` | Session cookie | none | `{ connected, hasGmail, scopes?, reason }` | [C89](#c89-gmail-check) |
| `GET` | `/api/gmail/message/:id` | Session or Bearer | path Gmail message id | `{ id, body }`; `403` no Google account | [C90](#c90-gmail-message) |
| `GET` | `/api/gmail/oauth/start` | Session cookie | Query optional return URL | Redirect/start response for Google Gmail OAuth; `500` if not configured | [C91](#c91-gmail-oauth-start) |
| `GET` | `/api/gmail/oauth/callback` | Gmail OAuth callback | Query `code`, `state` from Google | Redirects after attaching Google tokens | [C92](#c92-gmail-oauth-callback) |
| `POST` | `/api/gmail/send-draft` | Session or Bearer | JSON `{ to, subject?, draft, jobId? }` | `{ sent: true, to }` | [C93](#c93-gmail-send-draft) |
| `GET` | `/api/gmail/threads` | Session or Bearer | none | `{ emails, hasGmail: true }`; body error codes `NO_GOOGLE_ACCOUNT`, `TOKEN_EXPIRED`, `GMAIL_REAUTH`, `GMAIL_SCOPE_MISSING`, `GMAIL_ERROR` | [C94](#c94-gmail-threads) |
| `GET` | `/api/gmail/unread` | Session cookie | none | `{ unread, hasGmail }`; returns zero if unavailable | [C95](#c95-gmail-unread) |

## Dashboard

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/dashboard` | Session cookie | none | Dashboard aggregate counts, recent jobs/activity, Gmail/unread style widgets | [C96](#c96-dashboard) |

## Apply Results

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/apply-results` | Session or Bearer | Query filters, including job/task filters | `{ results }` | [C97](#c97-apply-results) |
| `GET` | `/api/apply-results/stats` | Session or Bearer | Query time/status filters | `{ stats }` | [C98](#c98-apply-result-stats) |

## Notifications

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/notifications` | Session or Bearer | Query pagination/status filters | `{ notifications, unreadCount }` | [C99](#c99-notifications) |
| `PATCH` | `/api/notifications/mark-read` | Session or Bearer | JSON `{ ids?: string[], all?: boolean }` | `{ ok: true }` | [C100](#c100-mark-notifications-read) |

## Activity

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/activity` | Session cookie | Query optional activity filters | Activity list | [C101](#c101-list-activity) |
| `POST` | `/api/activity` | Session cookie | JSON `{ type, text, jobId?, color? }`; requires `type` and `text` | Created activity; `201`; validates job ownership | [C102](#c102-create-activity) |

## Admin

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/admin/observability` | Public/internal dashboard route | none | Observability summary payload | [C103](#c103-admin-observability) |

## Directions

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/directions` | Session cookie | none | User directions | [C104](#c104-list-directions) |
| `POST` | `/api/directions` | Session cookie | JSON `{ name, keywords?, location?, salaryMin?, salaryMax? }`; `name` required, max 100 chars | Created direction; `201`; `409` duplicate | [C105](#c105-create-direction) |
| `PATCH` | `/api/directions/:id` | Session cookie | JSON direction fields; `name` cannot be empty | Updated direction; `404`, `409`, `422` | [C106](#c106-update-direction) |
| `DELETE` | `/api/directions/:id` | Session cookie | path `id` | Delete response; `404` if not found | [C107](#c107-delete-direction) |

## Market and Salary

| Method | Path | Auth | Request | Response and status | Curl |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/market/pulse` | Session or Bearer | Query market inputs, commonly `role`, `location`, `skills` | Market pulse object; cache may be used | [C108](#c108-market-pulse) |
| `GET` | `/api/salary/range` | Session or Bearer | Query `title`, optional `location`; RapidAPI key required | Salary range object; fallback fields when upstream incomplete | [C109](#c109-salary-range) |
| `GET` | `/api/salary/titles` | Session or Bearer | Query `query`; RapidAPI key required | `{ titles }` | [C110](#c110-salary-titles) |

## Curl Examples

### C01 Register

```bash
curl -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","password":"correct-horse-123","name":"Dev User"}'
```

### C02 Forgot Password

```bash
curl -X POST "$BASE_URL/api/auth/forgot-password" \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com"}'
```

### C03 Create Extension Token

```bash
curl -X POST "$BASE_URL/api/auth/extension-token" \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","password":"correct-horse-123"}'
```

### C04 Session Extension Token

```bash
curl -b cookie.txt "$BASE_URL/api/auth/me/extension-token"
```

### C05 NextAuth Session

```bash
curl -b cookie.txt "$BASE_URL/api/auth/session"
```

### C06 Get Profile

```bash
curl -b cookie.txt "$BASE_URL/api/me"
```

### C07 Update Profile

```bash
curl -X PATCH "$BASE_URL/api/me" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"name":"Dev User","location":"Dublin","linkedin":"https://linkedin.com/in/dev"}'
```

### C08 List Connected Accounts

```bash
curl -b cookie.txt "$BASE_URL/api/me/accounts"
```

### C09 Disconnect Account

```bash
curl -X DELETE "$BASE_URL/api/me/accounts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"google"}'
```

### C10 AI Budget

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/me/ai-budget"
```

### C11 Get AI Config

```bash
curl -b cookie.txt "$BASE_URL/api/me/ai-config"
```

### C12 Save AI Config

```bash
curl -X POST "$BASE_URL/api/me/ai-config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keys":{"openai":"sk-..."},"features":{"coverLetter":{"provider":"openai","model":"gpt-4o-mini"}}}'
```

### C13 Test AI Config

```bash
curl -X POST "$BASE_URL/api/me/ai-test" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","model":"gpt-4o-mini"}'
```

### C14 Get API Keys

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/me/api-keys"
```

### C15 Save API Keys

```bash
curl -X PUT "$BASE_URL/api/me/api-keys" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"adzunaAppId":"app-id","adzunaAppKey":"app-key","rapidapiKey":"rapidapi-key"}'
```

### C16 Delete Account

```bash
curl -X DELETE "$BASE_URL/api/me/delete" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com"}'
```

### C17 Save Onboarding

```bash
curl -X PATCH "$BASE_URL/api/me/onboarding" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"onboardingGoals":["find_jobs","tailor_resume"],"location":"Dublin"}'
```

### C18 Change Password

```bash
curl -X PATCH "$BASE_URL/api/me/password" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"correct-horse-123","newPassword":"new-correct-horse-123"}'
```

### C19 Get Persona

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/me/persona"
```

### C20 List Persona Fields

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/me/persona/fields"
```

### C21 Upsert Persona Fields

```bash
curl -X POST "$BASE_URL/api/me/persona/fields" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fields":[{"key":"workAuthorization","label":"Work authorization","value":"EU citizen","category":"profile"}]}'
```

### C22 Delete Persona Field

```bash
curl -X DELETE "$BASE_URL/api/me/persona/fields" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"workAuthorization"}'
```

### C23 List Jobs

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/jobs?status=saved&q=engineer&page=1&pageSize=25"
```

### C24 Create Job

```bash
curl -X POST "$BASE_URL/api/jobs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"company":"Acme","role":"Frontend Engineer","location":"Dublin","url":"https://example.com/jobs/1","source":"manual","status":"saved"}'
```

### C25 Get Job

```bash
curl -b cookie.txt "$BASE_URL/api/jobs/job_123"
```

### C26 Update Job

```bash
curl -X PATCH "$BASE_URL/api/jobs/job_123" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"status":"interviewing","score":82}'
```

### C27 Delete Job

```bash
curl -X DELETE -b cookie.txt "$BASE_URL/api/jobs/job_123"
```

### C28 Mark Job Applied

```bash
curl -X POST "$BASE_URL/api/jobs/job_123/apply" \
  -H "Authorization: Bearer $TOKEN"
```

### C29 Job Apply Results

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/jobs/job_123/apply-results"
```

### C30 Assign Job Assets

```bash
curl -X PATCH "$BASE_URL/api/jobs/job_123/assign" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resumeId":"resume_123","coverLetterId":"cl_123","directionId":"dir_123"}'
```

### C31 Queue Auto Apply

```bash
curl -X POST "$BASE_URL/api/jobs/job_123/auto-apply" \
  -H "Authorization: Bearer $TOKEN"
```

### C32 List Job Cover Letters

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/jobs/job_123/cover-letters"
```

### C33 Create Job Cover Letter

```bash
curl -X POST "$BASE_URL/api/jobs/job_123/cover-letters" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Dear Hiring Manager...","resumeId":"resume_123","tone":"professional","origin":"manual"}'
```

### C34 Generate Job Cover Letter

```bash
curl -X POST "$BASE_URL/api/jobs/job_123/cover-letters/generate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resumeId":"resume_123","tone":"professional","language":"en"}'
```

### C35 Enrich Job

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/jobs/job_123/enrich"
```

### C36 Tailor Resume for Job

```bash
curl -X POST "$BASE_URL/api/jobs/job_123/tailor-resume" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resumeId":"resume_123"}'
```

### C37 List Resumes

```bash
curl -b cookie.txt "$BASE_URL/api/resume"
```

### C38 Create Resume

```bash
curl -X POST "$BASE_URL/api/resume" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"name":"Base CV","content":{"contact":{"name":"Dev User"},"skills":["TypeScript"]},"isDefault":true}'
```

### C39 Get Resume

```bash
curl -b cookie.txt "$BASE_URL/api/resume/resume_123"
```

### C40 Update Resume

```bash
curl -X PATCH "$BASE_URL/api/resume/resume_123" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"name":"Frontend CV","isDefault":true}'
```

### C41 Delete Resume

```bash
curl -X DELETE -b cookie.txt "$BASE_URL/api/resume/resume_123"
```

### C42 List Resume Versions

```bash
curl -b cookie.txt "$BASE_URL/api/resume/resume_123/versions"
```

### C43 Restore Resume Version

```bash
curl -X POST "$BASE_URL/api/resume/resume_123/versions" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"versionId":"version_123"}'
```

### C44 Default Resume

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/resume/default?directionId=dir_123"
```

### C45 Resume Intake

```bash
curl -X POST "$BASE_URL/api/resume/intake" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Imported CV","content":{"summary":"Frontend engineer"},"source":"wizard"}'
```

### C46 Parse Resume

```bash
curl -X POST "$BASE_URL/api/resume/parse" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./resume.pdf"
```

### C47 Update Cover Letter

```bash
curl -X PATCH "$BASE_URL/api/cover-letters/cl_123" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Updated letter","isFinal":true}'
```

### C48 Delete Cover Letter

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/cover-letters/cl_123"
```

### C49 AI Cover Letter

```bash
curl -X POST "$BASE_URL/api/ai/cover-letter" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resumeContent":{"contact":{"name":"Dev User"},"skills":["React","TypeScript"]},"jobTitle":"Frontend Engineer","jobCompany":"Acme","tone":"professional","language":"en"}'
```

### C50 AI Field Suggest

```bash
curl -X POST "$BASE_URL/api/ai/field-suggest" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"Notice period","persona":"Available in 4 weeks","jobContext":"Frontend role"}'
```

### C51 AI Form Fill

```bash
curl -X POST "$BASE_URL/api/ai/form-fill" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"persona":"Frontend engineer in Dublin","fields":[{"id":"f1","type":"text","label":"Why this role?","required":true,"surroundingText":"Application question"}]}'
```

### C52 AI Form Fill Revise

```bash
curl -X POST "$BASE_URL/api/ai/form-fill/revise" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"persona":"Frontend engineer","fields":[{"id":"f1","type":"text","label":"Why us?","required":true}],"previousFill":[{"fieldId":"f1","value":"I like the company"}],"instruction":"Make it more specific"}'
```

### C53 AI Interview Prep

```bash
curl -X POST "$BASE_URL/api/ai/interview-prep" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jobTitle":"Frontend Engineer","jobCompany":"Acme","jobDescription":"React and TypeScript role"}'
```

### C54 AI Score

```bash
curl -X POST "$BASE_URL/api/ai/score" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resumeContent":{"skills":["React","TypeScript"]},"jobTitle":"Frontend Engineer","jobDescription":"React, TypeScript, testing"}'
```

### C55 AI Suggest

```bash
curl -X POST "$BASE_URL/api/ai/suggest" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resumeContent":{"summary":"Frontend engineer"},"jobDescription":"React role"}'
```

### C56 AI Translate

```bash
curl -X POST "$BASE_URL/api/ai/translate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Thank you for your consideration.","targetLang":"de"}'
```

### C57 Get Agent Config

```bash
curl -b cookie.txt "$BASE_URL/api/agent"
```

### C58 Update Agent Config

```bash
curl -X PATCH "$BASE_URL/api/agent" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"dailyLimit":20}'
```

### C59 Answer Agent Question

```bash
curl -X POST "$BASE_URL/api/agent/answer" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"questionId":"q_123","answer":"Yes, I can relocate."}'
```

### C60 Agent Chat

```bash
curl -X POST "$BASE_URL/api/agent/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Summarize my pipeline"}]}'
```

### C61 Agent History

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agent/history?jobId=job_123"
```

### C62 List Agent Roles

```bash
curl -b cookie.txt "$BASE_URL/api/agent/roles"
```

### C63 Update Agent Roles

```bash
curl -X PATCH "$BASE_URL/api/agent/roles" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"roles":{"writer":{"provider":"openai","model":"gpt-4o-mini"}}}'
```

### C64 Get Agent Role

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agent/roles/writer"
```

### C65 Update Agent Role

```bash
curl -X PATCH "$BASE_URL/api/agent/roles/writer" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"systemPrompt":"Write concise, specific cover letters.","provider":"openai","model":"gpt-4o-mini"}'
```

### C66 List Custom Agent Roles

```bash
curl -b cookie.txt "$BASE_URL/api/agent/roles/custom"
```

### C67 Create Custom Agent Role

```bash
curl -X POST "$BASE_URL/api/agent/roles/custom" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Recruiter screener","description":"Checks job fit","systemPrompt":"Be strict and concise."}'
```

### C68 Update Custom Agent Role

```bash
curl -X PATCH "$BASE_URL/api/agent/roles/custom/custom_123" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Recruiter screener v2"}'
```

### C69 Delete Custom Agent Role

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agent/roles/custom/custom_123"
```

### C70 Agent Run Status

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agent/run?taskId=task_123"
```

### C71 Queue Scout

```bash
curl -X POST "$BASE_URL/api/agent/scout" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"frontend engineer","location":"Dublin","limit":20}'
```

### C72 Unified Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/search/unified?q=frontend%20engineer&location=Dublin&page=1"
```

### C73 Adzuna Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/adzuna/search?q=frontend&location=Dublin&page=1"
```

### C74 ATS Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/ats/search?q=frontend&location=Dublin"
```

### C75 Bundesagentur Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/bundesagentur/search?q=entwickler&location=Berlin&page=1"
```

### C76 CareerJet Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/careerjet/search?q=frontend&location=Dublin&page=1"
```

### C77 Indeed Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/indeed/search?q=frontend&location=Dublin"
```

### C78 Internships Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/internships/search?q=software&location=remote&page=1"
```

### C79 IrishJobs Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/irishjobs/search?q=frontend&location=Dublin"
```

### C80 Jobicy Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/jobicy/search?q=frontend"
```

### C81 JSearch Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/jsearch/search?q=frontend%20engineer&page=1"
```

### C82 LinkedIn Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/linkedin/search?q=frontend&location=Dublin&page=1"
```

### C83 Mantiks Company

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/mantiks/company?website=stripe.com"
```

### C84 Mantiks Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/mantiks/search?q=fintech"
```

### C85 Reed Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/reed/search?q=frontend&location=London&page=1"
```

### C86 Remotive Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/remotive/search?q=frontend"
```

### C87 Xing Search

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/xing/search?q=frontend&location=Berlin"
```

### C88 Gmail AI Reply

```bash
curl -X POST "$BASE_URL/api/gmail/ai-reply" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subject":"Interview invitation","emailBody":"Can you speak Friday?","senderName":"Alex","senderEmail":"alex@example.com","tag":"interview"}'
```

### C89 Gmail Check

```bash
curl -b cookie.txt "$BASE_URL/api/gmail/check"
```

### C90 Gmail Message

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/gmail/message/gmail_message_id"
```

### C91 Gmail OAuth Start

```bash
curl -i -b cookie.txt "$BASE_URL/api/gmail/oauth/start"
```

### C92 Gmail OAuth Callback

```bash
curl -i "$BASE_URL/api/gmail/oauth/callback?code=google_code&state=signed_state"
```

### C93 Gmail Send Draft

```bash
curl -X POST "$BASE_URL/api/gmail/send-draft" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"recruiter@example.com","subject":"Following up","draft":"Dear Alex, thank you for the update.","jobId":"job_123"}'
```

### C94 Gmail Threads

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/gmail/threads"
```

### C95 Gmail Unread

```bash
curl -b cookie.txt "$BASE_URL/api/gmail/unread"
```

### C96 Dashboard

```bash
curl -b cookie.txt "$BASE_URL/api/dashboard"
```

### C97 Apply Results

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/apply-results?jobId=job_123"
```

### C98 Apply Result Stats

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/apply-results/stats"
```

### C99 Notifications

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/notifications"
```

### C100 Mark Notifications Read

```bash
curl -X PATCH "$BASE_URL/api/notifications/mark-read" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"all":true}'
```

### C101 List Activity

```bash
curl -b cookie.txt "$BASE_URL/api/activity"
```

### C102 Create Activity

```bash
curl -X POST "$BASE_URL/api/activity" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"type":"agent_action","text":"Reviewed application","jobId":"job_123","color":"#185FA5"}'
```

### C103 Admin Observability

```bash
curl "$BASE_URL/api/admin/observability"
```

### C104 List Directions

```bash
curl -b cookie.txt "$BASE_URL/api/directions"
```

### C105 Create Direction

```bash
curl -X POST "$BASE_URL/api/directions" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"name":"Frontend Ireland","keywords":["React","TypeScript"],"location":"Dublin"}'
```

### C106 Update Direction

```bash
curl -X PATCH "$BASE_URL/api/directions/dir_123" \
  -b cookie.txt \
  -H "Content-Type: application/json" \
  -d '{"name":"Frontend EU","location":"Remote"}'
```

### C107 Delete Direction

```bash
curl -X DELETE -b cookie.txt "$BASE_URL/api/directions/dir_123"
```

### C108 Market Pulse

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/market/pulse?role=Frontend%20Engineer&location=Dublin"
```

### C109 Salary Range

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/salary/range?title=Frontend%20Engineer&location=Dublin"
```

### C110 Salary Titles

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/salary/titles?query=frontend"
```
