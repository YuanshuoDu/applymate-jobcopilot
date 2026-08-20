# Changelog

All notable changes to ApplyMate AI. Dates in YYYY-MM-DD format.

---

## 2026-05-07 — Adzuna Job Search API Access

### Added
- **`GET /api/adzuna/search`**: new API routing, acting Adzuna official REST API, Normalized response format
  - parameter: `q`(keywords), `where`(City), `country`(gb/de/fr/nl/es/it/at/be/pl/us/ca/au), `page`, `job_type`
  - Salary formatting: `£68k – £137k`; Forecast salary plus `~` Prefix distinguishes real data
  - description truncation: Server end 180 Character
  - `cache: 'no-store'`, Live data for every search
- **`AdzunaSearchPanel` components** (`src/components/jobs/AdzunaSearchPanel.tsx`):
  - 12 country selector(Europe first: 🇬🇧🇩🇪🇫🇷🇳🇱🇪🇸🇮🇹🇦🇹🇧🇪🇵🇱 + US/CA/AU)
  - Job Result Card: salary(green), Release time(Today/3d ago), contract_time + contract_type pair badge
  - Load more Pagination, Automatically remove duplicates when appending(Defend Adzuna Overlapping page boundaries)
  - One click "+ Save" save to My Jobs(`source: 'adzuna'`), Show after saving "✓ Saved", external link "View ↗"

### Changed
- **`JobsPage`**: replace `IndeedSearchPanel` → `AdzunaSearchPanel`, button text "Search Indeed" → "🌍 Search Jobs"
- **`.env` / `.env.example`**: New `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` environment variables

### Removed
- **`POST /api/indeed/search`**: The route remains but is no longer used UI call(Indeed Publisher API Already at 2025 Abandoned)

### Fixed(This optimization)
- `AdzunaSearchPanel`: Remove unused `Card` import
- API routing: `next: { revalidate: 60 }` → `cache: 'no-store'`(user query different, Caching is pointless)
- Increase `salary_is_predicted` Field support, Forecasting salary `~` Prefix distinction
- Increase `contract_type`(permanent/contract)Field, Before completion, only `contract_time` of badge Missing
- Load more Add deduplication logic, prevent Adzuna Overlapping pagination results in duplicate entries

---

## 2026-05-06 — Dashboard Navigation, JobDetailDrawer, Resume

### Added
- **Dashboard fake buttons → real navigation**: `+ Add Job` → Jobs, `▶ Run Agent` → Agent, `Configure` → Settings, `Review Queue` → Jobs, `View all` → Jobs
- **JobDetailDrawer: Description / AI Analysis / Cover Letter display**: Three new read-only sections in the drawer body, scrollable with max-height, tinted backgrounds
- **Interview Prep feature**: New `POST /api/ai/interview-prep` route generates 6-8 questions + frameworks + company research + follow-up email template. Drawer shows "Generate Interview Prep" button when `job.status === 'interview'`
- **New user onboarding**: `OnboardingChecklist` component with 4-step progress bar, shown on Dashboard when `stats.total === 0`
- **Apply Basket real flow**: `✦ Tailor CVs` calls `POST /api/ai/cover-letter` for each job and saves via `PATCH /api/jobs/:id`. `Review & Apply` batch-sets `status: 'applied'` + `appliedAt`
- **Dashboard API `hasResume` flag**: Returns whether user has at least one resume, used by onboarding checklist
- **Cover Letter editing**: Edit/Add/Save buttons in JobDetailDrawer COVER LETTER section. Textarea with Ctrl+S shortcut
- **Resume version history**: New `ResumeVersion` model + `GET/POST /api/resume/[id]/versions` routes. Auto-snapshot on PATCH save (de-duplicated), restore with pre-restore backup
- **Version history UI**: "🕐 History" button in ResumePage TopBar → modal listing last 20 versions with restore buttons

### Fixed
- **AppShell.tsx**: Missing `</NavContext.Provider>` closing tag (pre-existing TS17008)
- **ResumeRenderer.tsx L312**: Sidebar template now renders custom sections (removed `!id.startsWith('custom_')` filter)
- **DashboardPage**: Removed unused `toast` variable after navigation refactor

### Changed
- **JobsPage JobDetailDrawer**: Interview prep state resets when switching between jobs. Cover letter edit state resets on job change.
- **Resume PATCH**: Version snapshots now only created when content actually differs (JSON comparison)
- **Restore API**: Creates a safety snapshot of current state before restoring to a version

### Schema
- **New model `ResumeVersion`**: `id`, `resumeId`, `userId`, `content` (Json), `name`, `createdAt`. Relations on `Resume` and `User`.
- **Indeed job search panel**: `IndeedSearchPanel` component with search form (title, location, country, job type) + results list with "Save" button. Toggle via TopBar `🔍 Search Indeed`.
- **Indeed API bridge**: `POST /api/indeed/search` route ready for INDEE_API_KEY integration or Claude Code MCP proxy.
