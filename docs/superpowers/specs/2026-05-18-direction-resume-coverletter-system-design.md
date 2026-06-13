# Direction · Resume · Cover Letter · Onboarding System — Design Spec

**Date:** 2026-05-18
**Status:** Approved for plan generation
**Scope phase:** Phase 1 ("Root & Branches"). Phase 2 (AI Adapt wizard, Screenshot OCR, AI Auto-Pilot full mode) is out of scope for this spec.

---

## 1. Motivation

Currently:
- `Resume` is a flat pool with no notion of career direction.
- `Job.coverLetter` is a single nullable text column — no versions, no PDF, no template alignment.
- No mechanism to link a Resume to a Job, or to pick a "final" resume / cover letter for an application.
- No way to download an application bundle (resume + cover letter) organised by company.
- No onboarding — users land on an empty Dashboard with no path to first value.

Target user: international students and young job seekers across **all industries** (not IT-only). They:
- Apply across multiple career directions in parallel (e.g. Marketing AND Data Analyst).
- Maintain a base resume per direction, then iteratively tailor it per company.
- Want one-click packaging of "everything for this application" filed by company.

This spec defines the data, APIs, UI, onboarding, and cross-page collaboration to support that workflow.

---

## 2. Concepts & Glossary

| Term | Meaning |
|---|---|
| **Direction** | A career track the user is targeting. Free-form string (industry-agnostic). User-owned, multi-allowed. |
| **Master Resume / Base Resume** | One canonical resume per direction. `Resume.kind = 'base'`. |
| **Adapted Resume** | A derivative tuned for a specific job. `Resume.kind = 'adapted'`, has `parentResumeId` and `targetJobId`. |
| **Final Resume** | The resume the user has chosen to apply with. Stored as `Job.finalResumeId`. Marked with ⭐ badge in UI. |
| **Cover Letter Version** | One of N drafts for a Job. The chosen one has `CoverLetter.isFinal = true` and is referenced by `Job.finalCoverLetterId`. |
| **Persona** | The user's stable identity profile (name, email, phone, address, nationality, visa, links). **Source of truth** for identity fields. |
| **Bundle** | The downloadable ZIP for a Job: `公司/岗位/Resume.pdf [+ CoverLetter.pdf] + meta.json`. |

---

## 3. Data Model

### 3.1 New tables

```prisma
model Direction {
  id        String   @id @default(cuid())
  userId    String
  name      String                          // free-form, multilingual (e.g. "市场营销 / Marketing")
  color     String?                         // hex, e.g. "#185FA5", for chip badge
  icon      String?                         // emoji or icon key
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user    User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  resumes Resume[]

  @@unique([userId, name])
  @@index([userId])
}

model CoverLetter {
  id              String   @id @default(cuid())
  userId          String
  jobId           String                              // CL is always Job-scoped
  resumeId        String?                             // resume providing style + header
  content         String   @db.Text
  tone            String   @default("professional")   // professional | enthusiastic | concise
  templateId      String?                             // snapshotted from resume at create time
  templateOptions Json?                               // snapshotted
  origin          String   @default("manual")         // manual | ai-generated
  isFinal         Boolean  @default(false)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user   User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  job    Job     @relation(fields: [jobId], references: [id], onDelete: Cascade)
  resume Resume? @relation(fields: [resumeId], references: [id], onDelete: SetNull)

  @@index([userId, jobId])
  @@index([jobId, isFinal])
}
```

### 3.2 Resume table extensions

```prisma
model Resume {
  // existing: id, userId, name, content, templateId, templateOptions, isDefault, createdAt, updatedAt

  // new
  directionId    String?
  kind           String   @default("base")   // base | adapted
  parentResumeId String?
  targetJobId    String?
  origin         String   @default("manual") // manual | upload | paste | ocr | ai-adapted
  basicsDetached Boolean  @default(false)    // when true, Persona stops syncing into basics

  direction    Direction?    @relation(fields: [directionId], references: [id], onDelete: SetNull)
  parent       Resume?       @relation("ResumeLineage", fields: [parentResumeId], references: [id], onDelete: SetNull)
  derivatives  Resume[]      @relation("ResumeLineage")
  targetJob    Job?          @relation("JobAdaptedResumes", fields: [targetJobId], references: [id], onDelete: SetNull)
  coverLetters CoverLetter[]

  @@index([userId, directionId])
  @@index([targetJobId])
}
```

### 3.3 Job table extensions

```prisma
model Job {
  // existing fields preserved; the legacy `coverLetter String?` field stays for ONE iteration
  // (migration source); marked @deprecated and removed in Phase 2.

  finalResumeId      String?
  finalCoverLetterId String?

  finalResume      Resume?       @relation("JobFinalResume",   fields: [finalResumeId],      references: [id], onDelete: SetNull)
  finalCoverLetter CoverLetter?  @relation("JobFinalCL",       fields: [finalCoverLetterId], references: [id], onDelete: SetNull)
  adaptedResumes   Resume[]      @relation("JobAdaptedResumes")
  coverLetters     CoverLetter[]
}
```

### 3.4 User table extensions (Onboarding + Persona pointers)

Persona itself already exists in the codebase (per memory). This spec only adds onboarding / preference fields.

```prisma
model User {
  onboardedAt        DateTime?
  onboardingGoals    String[]            // ["abroad","grad","switch","intern"]
  defaultTemplateId  String?
  defaultAccentColor String?
  defaultFontFamily  String?
  aiAutoPilot        String   @default("off")   // off | suggest | full   (Phase 2 wires "full")
}
```

### 3.5 Migration

One-off script `apps/web/scripts/migrate-cover-letter-string-to-table.ts`:

For each `Job` where `coverLetter IS NOT NULL`:
1. Insert `CoverLetter { jobId, userId, content, tone='professional', isFinal=true, origin='manual' }`.
2. Update `Job.finalCoverLetterId` to the new id.
3. Leave `Job.coverLetter` populated for one iteration as a safety net.

Drop `Job.coverLetter` in the Phase 2 sprint after observing zero reads from old code paths.

### 3.6 Referential integrity rules

| Action | Effect |
|---|---|
| Delete Direction | Owned Resumes' `directionId` → null. Resumes survive. |
| Delete Resume (base) | `parentResumeId` of derivatives → null (derivatives become orphans, still editable). Owned CLs' `resumeId` → null. |
| Delete Resume (adapted) | Same as above. If it was a Job's finalResumeId, that field → null. |
| Delete Job | Cascade delete owned CoverLetters. Adapted Resumes' `targetJobId` → null (resume content was user effort, preserve it as "orphan adapted"). |
| Delete CoverLetter | If it was a Job's finalCoverLetterId, that field → null. |

---

## 4. Backend API

All routes are Next.js Route Handlers under `apps/web/src/app/api/`. All require authenticated user; userId is taken from session, never trusted from body.

### 4.1 Directions

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET    | `/api/directions` | — | `Direction[]` with `_count.resumes` |
| POST   | `/api/directions` | `{ name, color?, icon? }` | `Direction` |
| PATCH  | `/api/directions/[id]` | partial `{ name?, color?, icon?, sortOrder? }` | `Direction` |
| DELETE | `/api/directions/[id]` | — | `204` |

Unique constraint on `(userId, name)`; duplicate POST → `409`.

### 4.2 Resumes (extends existing)

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET    | `/api/resumes?directionId=&jobId=&kind=` | filters optional | `Resume[]` grouped per query |
| POST   | `/api/resumes/intake` | `{ source: 'upload'\|'paste', directionId, file?: multipart, text?: string }` | `{ parsed: ResumeContent }` — no DB write yet |
| POST   | `/api/resumes` | `{ name, content, directionId?, kind, parentResumeId?, targetJobId?, origin, templateId?, templateOptions? }` | `Resume` |
| PATCH  | `/api/resumes/[id]` | partial fields | `Resume` |
| POST   | `/api/resumes/[id]/duplicate` | `{ name? }` | `Resume` (new id, copied content, kind=base) |
| DELETE | `/api/resumes/[id]` | — | `204` |

Two-step intake (`intake` then `POST /api/resumes`) is intentional so the user can review and edit AI parse output before committing.

### 4.3 Cover Letters

| Method | Path | Body | Returns |
|---|---|---|---|
| GET    | `/api/jobs/[jobId]/cover-letters` | — | `CoverLetter[]` ordered by createdAt desc |
| POST   | `/api/jobs/[jobId]/cover-letters` | `{ resumeId?, tone?, content? }` (blank draft if no content) | `CoverLetter` |
| POST   | `/api/jobs/[jobId]/cover-letters/generate` | `{ resumeId, tone }` | `CoverLetter` (origin='ai-generated', snapshots templateId/options from resume) |
| PATCH  | `/api/cover-letters/[id]` | partial `{ content?, tone? }` | `CoverLetter` |
| DELETE | `/api/cover-letters/[id]` | — | `204` |

Legacy `POST /api/ai/cover-letter` is retained for ONE iteration and internally delegates to `/generate`, returning `{ coverLetterId, content }` for backwards compatibility.

### 4.4 Job assignment

| Method | Path | Body | Returns |
|---|---|---|---|
| PATCH | `/api/jobs/[id]/assign` | `{ finalResumeId?: string\|null, finalCoverLetterId?: string\|null }` | `Job` |

Transactional. When `finalCoverLetterId` changes:
- Sets the new target's `isFinal = true`.
- Sets all sibling CLs (same jobId) `isFinal = false`.

Single endpoint instead of generic `PATCH /api/jobs/[id]` to encapsulate the cross-row side-effect.

### 4.5 Bundle (client-side only)

No server endpoint. Frontend fetches `/api/jobs/[id]` (with includes for `finalResume` and `finalCoverLetter`) and renders + zips locally — see §6.

---

## 5. UI

### 5.1 Resume page — direction-grouped library

`apps/web/src/components/pages/ResumePage.tsx`

Layout:

```
┌─ Resume Library ─────────────────────────────────────────────┐
│  [<DirA chip>] [<DirB chip>] [+ Add direction]   [+ Intake▾] │
├──────────────────────────────────────────────────────────────┤
│  📄 Master · <DirA>                          [Base] [Edit]   │
│    └ used by 3 jobs ↗                                        │
│  📄 For Google · Senior PD              [Adapted] [⭐ Final] │
│  📄 For Meta · Designer                     [Adapted] [Edit] │
└──────────────────────────────────────────────────────────────┘
```

Behaviour:
- Direction chips are horizontal scroll. `+ Add direction` opens a small dialog (name + color picker + emoji input).
- Per resume row: name, badges, action buttons. `used by N jobs ↗` is a popover linking back to My Jobs.
- `+ Intake` opens `ResumeIntakeDialog` (§5.4).
- No predefined industry list ever rendered here — onboarding owns the starter templates.

### 5.2 My Jobs detail drawer — Resume & Cover Letter section

`apps/web/src/components/pages/JobsPage.tsx` drawer gains a new section between JOB POSTING and Notes:

```
┌─ Resume & Cover Letter ──────────────────────────────────────┐
│  Resume:                                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Master · <Direction>                          ⭐ Final│    │
│  └─────────────────────────────────────────────────────┘    │
│  [▾ Switch resume]  [✦ AI Adapt (soon)]  [+ New]            │
│                                                               │
│  Cover Letter (optional):                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ v2 · enthusiastic · 2026-05-18                ⭐ Final│    │
│  └─────────────────────────────────────────────────────┘    │
│  [▾ Switch version]  [✦ Generate]  [✎ Edit]  [+ Blank]      │
│                                                               │
│  ───────────────────────────────────────────────────────     │
│  [⬇ Download bundle (.zip)]                                  │
└──────────────────────────────────────────────────────────────┘
```

- "Switch resume" dropdown sort order: (1) same-direction base resumes, (2) adapted resumes whose `targetJobId === currentJob.id`, (3) collapsed "Other directions ▾".
- "Switch version" lists this job's CLs as `v1 / v2 / …` newest first, with tone and createdAt.
- Selecting either invokes `PATCH /api/jobs/[id]/assign`.
- "AI Adapt" is rendered but `disabled` with tooltip `Coming in next iteration`.

### 5.3 Cover Letter side panel

`apps/web/src/components/coverletter/CoverLetterPanel.tsx` replaces `CoverLetterModal.tsx`.

- Right-side slide-in panel (~520px wide), coexists with the job drawer on its left.
- Top bar: version dropdown, tone chips, `Save` `Set as Final` `Delete`.
- Middle: textarea (auto-grow).
- Bottom: live PDF thumbnail preview with caption `with <ResumeName> · <TemplateName>`, making it obvious that style is borrowed from the resume.

Removal: `CoverLetterModal.tsx` is deleted in milestone M7. References in `JobsPage.tsx` and any other call sites updated atomically.

### 5.4 Resume intake dialog

`apps/web/src/components/resume/ResumeIntakeDialog.tsx`

Three-tab dialog:

| Tab | UI | Behaviour |
|---|---|---|
| Upload file | Drop zone, accepts `.pdf .docx` | POST `/api/resumes/intake { source:'upload', file }` |
| Paste text | Large textarea | POST `/api/resumes/intake { source:'paste', text }` |
| Screenshot | Disabled in Phase 1, tooltip `Coming in next iteration` | — |

Both tabs require a direction selection above the input (dropdown of existing + inline `+ create new`).

After response: two-pane preview (left raw, right structured `ResumeContent` editable). User clicks `Save as Master` → `POST /api/resumes { kind:'base', directionId, origin, content }`.

basics field auto-merge: structured parse → if Persona exists, basics in the preview are pre-filled from Persona, overriding the AI-parsed identity fields. The user can still edit but identity fields show an inline hint `Synced from Persona — edit there`.

### 5.5 Cross-page navigation

| From | To | Trigger |
|---|---|---|
| Resume row `used by N jobs ↗` | My Jobs drawer for that job | popover entry click |
| My Jobs Resume name link | Resume page, scrolled+highlighted | name text click |
| Dashboard `Adapted: 11` counter | Resume page filtered by `kind=adapted` | counter click |
| Settings → Onboarding restart | Step 1 of onboarding | button |

---

## 6. Bundle download (client-side)

### 6.1 New deps in `apps/web/package.json`

```
jszip      ^3.10
file-saver ^2.0
```

Both are dynamically imported on first bundle-download click to keep main bundle slim.

### 6.2 Flow

```ts
// apps/web/src/lib/bundle.ts
export async function downloadJobBundle(jobId: string) {
  const job = await fetchJobWithFinalAssets(jobId)
  if (!job.finalResume) throw new BundleError('No final resume selected')

  const [{ pdf }, { default: JSZip }, { saveAs }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('jszip'),
    import('file-saver'),
  ])

  const ResumeDoc = renderResumeDoc(job.finalResume)
  const resumeBlob = await pdf(ResumeDoc).toBlob()

  let coverBlob: Blob | null = null
  if (job.finalCoverLetter) {
    const CLDoc = renderCoverLetterDoc({
      templateId:      job.finalResume.templateId,
      templateOptions: job.finalResume.templateOptions,
      content:         job.finalCoverLetter.content,
      applicant:       resolveApplicantFromPersonaOrResume(job.finalResume),
      recipient:       { company: job.company, role: job.role },
      date:            new Date(),
    })
    coverBlob = await pdf(CLDoc).toBlob()
  }

  const zip = new JSZip()
  const folder = zip.folder(`${safe(job.company)}/${safe(job.role)}`)!
  folder.file('Resume.pdf', resumeBlob)
  if (coverBlob) folder.file('CoverLetter.pdf', coverBlob)
  folder.file('meta.json', JSON.stringify(buildMeta(job), null, 2))

  const blob = await zip.generateAsync({ type: 'blob' })
  const date = new Date().toISOString().slice(0, 10)
  saveAs(blob, `${safe(job.company)}_${safe(job.role)}_${date}.zip`)
}

function safe(s: string): string {
  return (s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 80)) || 'Untitled'
}
```

### 6.3 ZIP layout

```
<Company>_<Role>_<YYYY-MM-DD>.zip
└── <Company>/
    └── <Role>/
        ├── Resume.pdf
        ├── CoverLetter.pdf      (only if finalCoverLetterId set)
        └── meta.json
```

Outer filename ensures multiple exports of the same job don't overwrite. Inner nested folders mean the user can mass-extract many bundles into one directory and they auto-organize under a per-company tree.

### 6.4 meta.json schema

```json
{
  "exportedAt": "ISO-8601",
  "exportedBy": "ApplyMate vX.Y",
  "appliedAt":  "ISO-8601 | null",
  "company":    "string",
  "role":       "string",
  "jobUrl":     "string | null",
  "direction":  "string | null",
  "resume":      { "id": "...", "name": "...", "templateId": "...", "updatedAt": "..." },
  "coverLetter": { "id": "...", "tone": "...", "createdAt": "..." } | null
}
```

### 6.5 Cover Letter PDF templates

New folder `apps/web/src/components/resume/templates/cover-letter/`:

- `ModernCoverLetter.tsx`
- `ClassicCoverLetter.tsx`
- `MinimalCoverLetter.tsx`
- shared `CoverLetterFrame.tsx`: takes `templateOptions` (accentColor / fontFamily / density) and renders header (from Persona / resume basics), date, recipient, body, signature.

Mapping: `templateId` on the resume selects the matching CL template. Fonts are reused from the resume registry (no double `Font.register`).

### 6.6 Error handling

- No final resume → block button with tooltip `Pick a resume first`.
- PDF render throw → toast `Couldn't render <Resume|CoverLetter> PDF — open the editor and save again`.
- Network fetch fail → toast, abort before packaging.

---

## 7. Onboarding (5 steps)

Triggered on first login when `User.onboardedAt IS NULL`. Skippable in full, also resumable mid-flow (progress persisted after each step). Restartable from Settings → Profile.

### Step 1 — Welcome & Goal
- Multi-select chips: `Studying abroad job hunt`, `New grad`, `Career switch`, `Internship`.
- Stores `User.onboardingGoals[]`.

### Step 2 — About You (Persona)
- Form fields: full name*, email*, phone, city/country, nationality, visa status, LinkedIn URL, personal site.
- Writes to existing Persona table. Only name + email required.
- This is the **first** establishment of Persona — source of truth begins here.

### Step 3 — Pick Your Directions
- Free-form `+ Add direction` input.
- Collapsed "Need ideas?" section reveals 5 grouped starter templates (Business/Consulting/Finance, Data/Tech, Culture/Edu/Media, Legal/Medical/Public, Creative/Design). Each chip click adds it as a direction.
- At least 1 direction required to advance (Skip-all still possible).
- Batch `POST /api/directions`.

### Step 4 — Drop In Your Resume(s)
- For each direction from Step 3, render a row with `[Upload] [Paste] [Skip]`.
- Action opens `ResumeIntakeDialog` with direction pre-selected.
- basics in the intake preview are pre-filled from Persona captured in Step 2.
- At least one direction with a resume to advance; others can be added later.

### Step 5 — Style + Connect
- Top half: default template (Modern / Classic / Minimal), accent color, font family. Writes `User.defaultTemplate*`.
- Bottom half three cards:
  - **Install Chrome Extension** → external link.
  - **Connect Gmail** → existing Gmail Tracker flow.
  - **Try AI Auto-Pilot** → switches `User.aiAutoPilot` between `off / suggest` (full is Phase 2).
- `Finish` sets `User.onboardedAt = now()`.

### Empty-state fallback
If user skipped Step N, the first time they hit an empty Resume Library / empty My Jobs we show a slim banner:
> Looks like you haven't set up your directions yet — [Start setup]
linking back to the specific onboarding step.

### i18n
All onboarding strings under `onboarding.*` namespace, en/zh.

---

## 8. Page responsibility map & shared anchors

### 8.1 Page subjects

| Page | Owns | Does not own |
|---|---|---|
| Dashboard | Overview + action entries | Editing |
| My Jobs | Job lifecycle + per-job selection of resume/CL + bundle download | Resume editing (switches and triggers only) |
| Resume | Resume assets grouped by direction + editor + template style | Job linkage management (shows ⭐ Final badge + reverse link only) |
| Cover Letter | No dedicated page — lives under Job (panel) and is surfaced in Resume Library as reverse stats | — |
| Search Jobs | Discover → push to My Jobs | Anything after creation |
| Gmail Tracker | Emails ↔ Job status | Editing |
| Agent Playground | Automation rules | Execution |
| Settings | Preferences / API keys / Auto-Pilot / Persona / Direction advanced edits | — |

### 8.2 Cross-page anchors

- Resume row → `used by N jobs ↗` popover → click navigates to My Jobs drawer.
- My Jobs Resume name → click navigates to Resume page with row highlighted.
- Dashboard counters (Directions / Master / Adapted / Pipeline) → clickable, route to filtered Resume / My Jobs.
- Settings → Resume assets bulk operations (delete, reassign direction).

### 8.3 Source-of-truth rules

| Field | SoT | Consumers |
|---|---|---|
| Identity (name, email, phone, address, nationality, visa, links) | **Persona** | Resume.basics (auto-sync unless `basicsDetached`), CoverLetter header, Form Auto-Fill |
| Resume non-basics (experience, education, skills, projects) | Resume | CL generation prompt context |
| Resume style (templateId, options) | Resume | CL PDF render reuses |
| Job lifecycle status | Job | Dashboard stats, Gmail Tracker filters |
| Final resume / final CL for application | Job (finalXxxId fields) + CoverLetter.isFinal mirror | Bundle download |

### 8.4 Data flow

```
Persona ──fill──→ Resume.basics (unless detached)
Direction ──group──→ Resume(base) ──derive──→ Resume(adapted)
                                                    │
                                                    ▼
                                  Job ←── finalResumeId / finalCoverLetterId
                                                    ▲
                                                    │
                                              CoverLetter (jobId, resumeId)
```

- Resume does not know which Jobs use it; reverse-query when displaying `used by N jobs`.
- Job knows its final assets directly (single-source ids).

### 8.5 Interaction with existing Form Auto-Fill / Persona system

- Form Auto-Fill priority: **Persona → finalResume.basics (fallback)** when the current page context has a Job.
- Without Job context: Persona → default resume.basics.
- The Extension Sidebar Resume Tab now reads direction grouping; selecting a resume in the sidebar surfaces both base and adapted versions.

---

## 9. i18n

All new strings double-keyed en/zh in `apps/web/src/lib/i18n.tsx` under namespaces:

- `onboarding.*` (step1..5 titles, descriptions, CTAs, starter template labels)
- `direction.*` (chip actions, add dialog, delete confirm)
- `resume.intake.*` (tabs, dropzone hints, parsing toast, preview captions)
- `resume.lineage.*` (Base, Adapted, Final badges, "used by N jobs")
- `jobs.assign.*` (Switch resume, AI Adapt soon, dropdown groupings)
- `coverLetter.version.*` (v1/v2 labels, tone names, save/set final/delete)
- `bundle.*` (download button, error toasts, packaging progress)

---

## 10. Milestones

Each milestone is independently shippable and verifiable.

| M | Goal | Verifiable outcome |
|---|---|---|
| M1 | Schema + migration script | `prisma migrate dev` produces a named migration file; running migration on a copy of prod data succeeds and legacy `Job.coverLetter` text shows up in CoverLetter table |
| M2 | Directions CRUD + Resume Library chips | Create / rename / delete direction; chips render |
| M3 | Resume intake (upload / paste) + intake dialog | Upload PDF → preview → save → appears under correct direction as Base |
| M4 | Resume library badges + reverse-link popover | Final / Adapted / Base badges; "used by N jobs" works |
| M5 | CoverLetter table + new endpoints (legacy /api/ai/cover-letter delegates) | Old `CoverLetterModal` still works via legacy route |
| M6 | My Jobs assignment UI + `/assign` endpoint | Switch resume and CL in drawer, persist, refresh stable |
| M7 | CoverLetterPanel replaces Modal; old Modal deleted | All CL editing happens via side panel; no Modal references remain |
| M8 | CoverLetter PDF templates (Modern / Classic / Minimal) | CL preview matches resume style; PDF export legible |
| M9 | Bundle download (client-side ZIP) | `[⬇ Download]` produces correct ZIP, opens in finder, structure matches §6.3 |
| M10 | Onboarding (5 steps) + i18n + regression sweep + memory update | New user signup walks through 5 steps and lands with persona + ≥1 direction + ≥1 resume + default template |

Phase 2 (out of scope for this spec): AI Adapt wizard, Screenshot OCR, AI Auto-Pilot `full` mode, drop legacy `Job.coverLetter` column.

---

## 11. Risk & mitigation

| Risk | Mitigation |
|---|---|
| Legacy `CoverLetterModal` and new `CoverLetterPanel` coexisting causes call-site drift | M5 makes legacy route a thin delegate; M7 deletes the Modal in the same PR that introduces Panel call-sites |
| `@react-pdf/renderer` bloats main bundle | Bundle download path uses dynamic import for pdf / jszip / file-saver |
| Users spam Generate → CL row explosion | UI shows latest 5 versions, older collapsed; no DB cap |
| Orphan adapted resume after Job delete | Keep resume content, render with `Adapted (orphan)` badge and offer "Change direction / Convert to base" actions |
| Resume content changes after download → ZIP and current state diverge | `meta.json` records `resume.updatedAt`; user can re-download |
| Persona updates accidentally overwrite intentional resume customisations | `basicsDetached` flag per resume opts out of Persona sync, surfaced as an explicit user action |
| `prisma db push` on prod without migration history | Use migration files (`prisma migrate dev`) rather than `db push` from M1 onward |

---

## 12. Out of scope (explicit non-goals)

- Screenshot OCR ingestion (Phase 2).
- AI "Adapt for this job" derivation wizard (button is shown disabled in Phase 1).
- AI Auto-Pilot `full` autonomous mode (only `off` and `suggest` selectable).
- Multi-language cover letter generation beyond what current cover-letter prompt supports.
- Versioned diff UI between resume versions.
- Sharing / collaborative editing of resumes.
- Direct write to a user-chosen local folder via File System Access API (chose ZIP route in §4).

---

## 13. Open follow-ups for plan stage

- Concrete extraction pipeline for PDF/DOCX in `/api/resumes/intake` (currently assumed to reuse the existing upload-parse code path — plan stage to verify).
- Naming of the existing Persona table / fields (memory references it but plan stage will confirm against `schema.prisma`).
- Decision on whether Direction `color` is free-input hex or palette-picked (plan stage to choose palette of 8).
- Exact CL template font choices to match the existing 3 resume templates.
