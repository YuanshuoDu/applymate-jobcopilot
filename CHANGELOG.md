# Changelog

All notable changes to ApplyMate AI. Dates in YYYY-MM-DD format.

---

## 2026-05-07 — Adzuna Job Search API 接入

### Added
- **`GET /api/adzuna/search`**: 新 API 路由，代理 Adzuna 官方 REST API，归一化响应格式
  - 参数：`q`（关键词）、`where`（城市）、`country`（gb/de/fr/nl/es/it/at/be/pl/us/ca/au）、`page`、`job_type`
  - 薪资格式化：`£68k – £137k`；预测薪资加 `~` 前缀区分真实数据
  - 描述截断：服务端截至 180 字
  - `cache: 'no-store'`，每次搜索实时数据
- **`AdzunaSearchPanel` 组件** (`src/components/jobs/AdzunaSearchPanel.tsx`):
  - 12 国选择器（欧洲优先：🇬🇧🇩🇪🇫🇷🇳🇱🇪🇸🇮🇹🇦🇹🇧🇪🇵🇱 + US/CA/AU）
  - 职位结果卡片：薪资（绿色）、发布时间（Today/3d ago）、contract_time + contract_type 双 badge
  - Load more 分页，追加时自动去重（防 Adzuna 分页边界重叠）
  - 一键 "+ Save" 保存到 My Jobs（`source: 'adzuna'`），保存后显示 "✓ Saved"，外链 "View ↗"

### Changed
- **`JobsPage`**: 替换 `IndeedSearchPanel` → `AdzunaSearchPanel`，按钮文字 "Search Indeed" → "🌍 Search Jobs"
- **`.env` / `.env.example`**: 新增 `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` 环境变量

### Removed
- **`POST /api/indeed/search`**: 路由保留但不再被 UI 调用（Indeed Publisher API 已于 2025 年废弃）

### Fixed（本次优化）
- `AdzunaSearchPanel`: 移除未使用的 `Card` import
- API 路由：`next: { revalidate: 60 }` → `cache: 'no-store'`（用户 query 各异，缓存无意义）
- 增加 `salary_is_predicted` 字段支持，预测薪资用 `~` 前缀区分
- 增加 `contract_type`（permanent/contract）字段，补全之前只有 `contract_time` 的 badge 缺失
- Load more 追加去重逻辑，防止 Adzuna 分页重叠导致重复条目

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
