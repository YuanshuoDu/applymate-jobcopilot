# ApplyMate AI — UI Design Prompts

> 适用工具：v0.dev · Cursor · Lovable · Claude · Figma AI · Midjourney
> 技术栈：Next.js 15 · shadcn/ui · Tailwind CSS 4.0 · WXT (Chrome Extension)

---

## 设计系统基础（每次生成前附加此段）

```
Design system:
- Style: Clean, minimal, professional. Inspired by Linear and Vercel Dashboard.
- Colors: Primary blue #185FA5, success green #3B6D11, warning amber #854F0B, danger red #A32D2D. Neutral grays for backgrounds.
- Typography: Inter or system-ui. Weights 400 (body) and 500 (headings/labels) only. No bold 600+.
- Spacing: 8px base unit. Component padding 12–16px. Section gaps 20–24px.
- Borders: 0.5px solid with low-opacity gray. Border-radius 8px (components), 12px (cards).
- Shadows: None. Flat surfaces only.
- Components: shadcn/ui primitives. Tailwind CSS utility classes.
- Dark mode: Full support via CSS variables.
- Icons: lucide-react, 16px default size.
- No gradients, no decorative backgrounds, no heavy drop shadows.
```

---

## 一、Chrome Extension — Popup

### Prompt

```
Build a Chrome Extension popup UI component using React + shadcn/ui + Tailwind CSS.

Size: 360px wide, auto height. Renders when user clicks the toolbar icon.

[Design system: see above]

Layout (top to bottom):

1. Header bar (bg-secondary, border-bottom):
   - Left: logo mark (20×20 rounded square, blue #185FA5) + "ApplyMate AI" text (13px, weight 500)
   - Right: green "Active" pill badge + close × button

2. Job detection banner (blue tinted card, mx-3 mt-3):
   - Detected label (10px, blue, uppercase): "JOB DETECTED ON THIS PAGE"
   - Job title (13px, weight 500, dark blue): e.g. "Software Engineer, Backend"
   - Company · Location · Salary (11px, medium blue)
   - Right side: match score pill "87%" (white text on blue bg, rounded-full)
   - If no job detected: show muted "No job found on this page" state with a search icon

3. Quick actions grid (2×2, gap-2, px-3):
   - "One-click apply" (primary, blue bg): icon + label + sub-label "Auto-fill + submit"
   - "Open sidebar": icon + label + sub-label "Full job analysis"
   - "Save job": icon + label + sub-label "Add to tracker"
   - "Tailor CV": icon + label + sub-label "AI optimized"

4. Divider

5. Mini stats row (3 columns, equal width, center-aligned):
   - Applied: 47 | Interviews: 5 | Offers: 1
   - Each: large number (16px, weight 500) + label (10px, muted)

States to handle:
- Default (job detected)
- No job detected
- Loading (skeleton placeholders)
- Applied (success state with checkmark replacing the apply button)

Props: jobData?: { title, company, location, salary, matchScore }, stats: { applied, interviews, offers }
```

---

## 二、Chrome Extension — Sidebar Panel

### Prompt

```
Build a Chrome Extension sidebar panel injected into LinkedIn/Indeed job pages.
Use React + shadcn/ui + Tailwind CSS.

Size: 320px wide, full viewport height, fixed right side. Has internal scroll per tab.

[Design system: see above]

Structure:

1. Header (sticky, bg-secondary, border-bottom):
   - Logo mark + "ApplyMate AI" title
   - Close button (×)

2. Job banner card (mx-2 my-2, blue tinted bg):
   - Job title (13px, weight 500) + company/location (11px)
   - Match score ring (SVG circle progress, 48×48) showing percentage
   - Skill tags row: blue pills for detected skills

3. Tab bar (3 tabs, border-bottom):
   - "Analysis" | "Auto-fill" (with badge showing issues count) | "Cover letter"
   - Active tab: border-bottom 2px blue, weight 500

4. Tab content (scrollable):

   TAB A — Analysis:
   - "Requirements match" section:
     Each row: icon (✓ green / ⚠ amber / ✕ red, 18×18 rounded square bg) + requirement text (12px) + sub-text (10px, muted)
   - "Skills on your CV" section:
     Pill tags in 3 colors: green (have), amber (partial), red (missing)
   - "Company insights" section:
     2×2 grid of metric cards: company size, avg response time, interview rounds, applicant count
   - "AI suggestions" section:
     Bulleted list of 3 tips with colored dots, + "Optimize CV for this role" button

   TAB B — Auto-fill:
   - Grouped fields with section headers ("Basic info", "Documents", "Application questions")
   - Each field: label row (10px muted + "required" red badge) + value row (bg-secondary, 11px text, "auto"/"AI" badge, "Edit" link)
   - Warning state: amber border + amber bg for fields needing review
   - Missing state: red border + red bg for unanswered required fields
   - Bottom warning banner if issues exist

   TAB C — Cover letter:
   - Tone selector pills: "Professional" | "Confident" | "Concise" (active = blue filled)
   - Editor area: scrollable text with AI-highlighted keyword spans (blue tinted)
   - Stats row: word count, reading time, keywords matched (X/8)
   - Action row: "Rewrite" ghost button + "Full editor" primary button

5. Apply bar (sticky bottom, bg-secondary, border-top):
   - "Save job" ghost button (left)
   - "Apply now →" primary button (flex-1, blue)
   - Disabled state when required fields are missing

Success state (replaces content after apply):
- Large checkmark icon (52×52 green circle)
- "You applied to [Company]!" title
- Receipt card: role, company, resume sent, cover letter, match score, timestamp
- Timeline: Applied (done) → Screening → Interview → Offer
- Action list: "Open in dashboard" | "Schedule follow-up" | "Find similar roles"
- Footer: today's apply count + close button
```

---

## 三、Web Dashboard — 整体布局

### Prompt

```
Build the main layout shell for ApplyMate AI web dashboard.
Use Next.js 15 App Router + shadcn/ui + Tailwind CSS 4.0.

[Design system: see above]

Layout: Fixed sidebar + scrollable main content area. Full viewport height.

LEFT SIDEBAR (200px wide, fixed, bg-secondary, border-right):

  Top section:
  - Logo area (px-4, pb-4, border-bottom): logo mark (24×24 blue rounded) + "ApplyMate AI" (14px, 500) + "Job Copilot" (11px, muted)

  Navigation (mt-2):
  Each nav item (px-4 py-2, flex, gap-2, 13px):
  - Icon (lucide, 14px, opacity-60 → 1 when active)
  - Label
  - Active state: bg-background (white card), font-weight 500
  - Hover: bg-background
  
  Nav items:
  - Dashboard (LayoutDashboard icon)
  - Jobs (Briefcase icon)
  - Resume (FileText icon)
  - AI Agent (Clock icon)
  - Settings (Settings icon)

  Bottom (mt-auto, pt-3, border-top, px-4):
  - User avatar (28×28 circle, initials, blue tinted bg)
  - Name (12px, 500) + plan (10px, muted)
  - Settings gear icon (right)

TOP BAR (sticky, bg-background, border-bottom, h-12):
  - Left: page title (14px, weight 500), breadcrumb if needed
  - Right: action buttons (ghost + primary)

MAIN CONTENT (flex-1, overflow-y-auto, bg-tertiary, p-5):
  - Slot for page content

Responsive: sidebar collapses to icon-only on <1024px. Mobile: bottom tab bar.
```

---

## 四、Web Dashboard — Dashboard 首页

### Prompt

```
Build the Dashboard overview page for ApplyMate AI.
Use shadcn/ui Card, Badge, Button, Progress components + Tailwind CSS.

[Design system: see above]

Page title: "Dashboard"
Top action buttons: "+ Add Job" (ghost) | "Run Agent" (primary blue)

SECTION 1 — Stats cards row (grid 4 cols, gap-3):
Each card (bg-background, border, rounded-lg, p-4):
- Muted label (11px): "Total Applied" / "In Review" / "Interviews" / "Offers"
- Large number (22px, weight 500)
- Delta text (11px): green for positive ("↑ 8 this week"), muted for neutral

SECTION 2 — Two-column grid (gap-4):

Left card — "Recent applications" table:
  Columns: Company (logo + name) | Role | Status | Date applied
  Each row hover: bg-secondary
  Status badges (rounded-full, 11px):
  - Applied: blue bg/text
  - In review: amber bg/text
  - Interview: green bg/text
  - Rejected: red bg/text
  - Offer: teal bg/text
  "View all" ghost button in card header

Right card — "AI Agent" status:
  Header: "AI Agent" title + green/gray status dot + "Running"/"Paused" text
  Body:
  - Status description: "Scanning LinkedIn · 14 matches today"
  - Progress bars (label + value + colored bar):
    · Daily target: 8/10 (blue bar)
    · Match score avg: 82% (green bar)
    · Auto-applied: N pending review (no bar)
  - Action buttons: "Configure" ghost + "Pause" ghost (red text)

SECTION 3 — Pipeline bar chart (full width card):
  Simple horizontal bars showing funnel: Applied → Review → Interview → Rejected → Offer
  Each bar: colored fill, label below, count above
  No chart library needed — use CSS height + flexbox

SECTION 4 — Recent activity feed (full width card):
  Timeline list, each item:
  - Colored dot (status color) + vertical line connector
  - Action text (12px): "Applied to Google · SWE Intern"
  - Timestamp (10px, muted): "2 hours ago"
```

---

## 五、Web Dashboard — Jobs 列表页

### Prompt

```
Build the Jobs page with dual view (list + kanban) for ApplyMate AI.
Use shadcn/ui + Tailwind CSS + @dnd-kit for kanban drag.

[Design system: see above]

PAGE HEADER:
- Title "Jobs" + count badge (total)
- Right: search input (240px) + filter dropdowns (Status, Location, Date) + "List / Kanban" view toggle (icon buttons)
- "+ Add Job" primary button

FILTER BAR (sticky below header, border-bottom, py-2, flex gap-2):
Active filters as removable pills. "Clear all" link if any active.

--- LIST VIEW ---
Table with sortable columns:
- Company (logo 24×24 + name + location, 2 lines)
- Role title
- Status badge
- Match score (colored number: green >80%, amber 60–80%, red <60%)
- Applied date
- Follow-up date (amber if overdue)
- Actions (⋯ menu: View, Edit, Delete)

Hover row: bg-secondary, cursor-pointer
Empty state: centered icon + "No jobs yet" + "Add your first job" button

--- KANBAN VIEW ---
Horizontal scroll columns, one per status:
Columns: Saved | Applied | In Review | Interview | Offer | Rejected

Each column:
- Header: status label + count badge + column color dot
- Cards (draggable, bg-background, border, rounded-lg, p-3, mb-2):
  · Company logo (20×20) + company name (12px, 500)
  · Role title (11px, muted)
  · Match score pill (right aligned)
  · Applied date (10px, muted, bottom)
  · On hover: subtle border-color change

Drag state: card has slight scale(1.02), box-shadow
Drop zone: dashed border highlight

"+ Add job" ghost button at bottom of each column.
```

---

## 六、Web Dashboard — Resume 编辑器

### Prompt

```
Build the Resume editor page for ApplyMate AI.
Use shadcn/ui + Tailwind CSS + Tiptap rich text editor.

[Design system: see above]

TWO-COLUMN LAYOUT (60% editor / 40% AI panel):

LEFT — RESUME EDITOR:
  Top toolbar (sticky, border-bottom, flex, gap-1):
  - Document title input (inline editable, 14px, weight 500)
  - Formatting buttons (B, I, U, H1, H2, bullet list) using lucide icons
  - Divider
  - "Tailor for job" dropdown (select target job from tracker)
  - "Download PDF" button (ghost)
  - "Save" button (primary)

  Editor area (Tiptap, px-8 py-6, A4-style max-width 680px, bg-background, border, rounded-lg):
  - Section headers: bold, 14px, border-bottom
  - Standard sections: Summary, Experience, Skills, Education, Projects
  - Inline edit on click
  - AI-highlighted phrases: blue underline with tooltip "Matched keyword"

RIGHT — AI PANEL:
  Sticky, full height, border-left, bg-secondary, px-4 py-4, overflow-y-auto

  "Tailoring for" job card (if job selected):
  - Company + role + match score ring
  
  "Keyword gaps" section:
  - Missing keywords as red pills: click to add to resume
  - Matched keywords as green pills

  "AI suggestions" list:
  - Each suggestion: text description + "Apply" button
  - Clicking "Apply" highlights the relevant section and suggests rewrite

  "Section scores" breakdown:
  - Each section: label + score bar (0–100%) + improvement tip

  "Rewrite section" button: opens modal with AI-generated alternatives
```

---

## 七、Web Dashboard — AI Agent 配置页

### Prompt

```
Build the AI Agent control panel page for ApplyMate AI.
Use shadcn/ui Switch, Slider, Select, Card + Tailwind CSS.

[Design system: see above]

PAGE HEADER:
- Title "AI Agent" + status indicator (green dot "Running" / gray "Paused")
- "Pause Agent" / "Resume Agent" primary button (state-aware)

SECTION 1 — Agent status card (border, rounded-lg, p-4):
- Live stats: Jobs scanned today | Auto-applied | Pending review | Rejected by rules
- Progress bar: daily target (e.g. 8/10 applications)
- Last action: "Applied to Adyen · 14 mins ago"
- Activity log (scrollable, max-h-40): timestamped entries

SECTION 2 — Configuration (two columns):

Left column cards:
  "Job matching rules" card:
  - Min match score: Slider (0–100, default 70)
  - Target roles: multi-select tags input
  - Target locations: multi-select (with remote toggle)
  - Salary range: dual-handle slider (EUR)
  - Exclude companies: text input with pill tags

  "Application limits" card:
  - Max applications per day: number input (stepper)
  - Apply between hours: time range selector
  - Skip if already applied: toggle (on by default)

Right column cards:
  "Auto-apply settings" card:
  - Auto-apply when match score ≥ N: toggle + threshold slider
  - Require manual review below N%: toggle
  - Auto-generate cover letter: toggle
  - Cover letter tone: Select (Professional / Confident / Concise)
  - Use tailored CV: toggle (generates per-job CV variant)

  "Notifications" card:
  - Notify on auto-apply: toggle
  - Notify on rejection: toggle
  - Weekly summary email: toggle
  - Follow-up reminders: toggle + days input

SECTION 3 — Blocklist / Allowlist (full width):
  Two-column: Companies to avoid | Priority companies (always apply)
  Each: search + tag list + add button

Save settings: sticky bottom bar with "Reset to defaults" ghost + "Save changes" primary
```

---

## 八、通用组件 Prompt

### Status Badge

```
Create a StatusBadge component in React + Tailwind CSS.

Props: status: 'saved' | 'applied' | 'review' | 'interview' | 'offer' | 'rejected'

Each status maps to:
- saved:     gray bg/text,   label "Saved"
- applied:   blue bg/text,   label "Applied"
- review:    amber bg/text,  label "In Review"
- interview: green bg/text,  label "Interview"
- offer:     teal bg/text,   label "Offer"
- rejected:  red bg/text,    label "Rejected"

Style: rounded-full, text-11px, px-2 py-0.5, inline-flex items-center gap-1
Include colored dot (5×5 circle) before text.
No border. Background at ~15% opacity of the text color.
```

### Match Score Ring

```
Create a MatchScoreRing component in React + SVG + Tailwind CSS.

Props: score: number (0–100), size?: 'sm' | 'md' | 'lg'

Sizes: sm=36px, md=48px, lg=64px
Track: thin gray circle (stroke-width 3, opacity 0.15)
Fill: colored arc (stroke-linecap round), color based on score:
  - ≥80: blue #185FA5
  - 60–79: amber #BA7517
  - <60: red #E24B4A

Center text: score + "%" (proportional font-size, weight 500, matching color)
Below ring: optional "match" label (9px, muted)

Animate fill on mount: stroke-dashoffset transition 0.6s ease-out
```

### Toast Notification

```
Create a Toast notification system in React + Tailwind CSS.

Variants: 'success' | 'info' | 'warning' | 'error'

Position: fixed bottom-4 right-4, z-50
Stack: multiple toasts stack vertically with gap-2
Enter animation: slide up + fade in (translateY 8px → 0, opacity 0 → 1)
Exit animation: fade out + slide down
Auto-dismiss: 4 seconds (show progress bar draining)

Each toast (300px wide, bg-background, border, rounded-lg, p-3, shadow-sm):
- Left icon (28×28 rounded square, colored bg based on variant)
  · success: green bg, checkmark icon
  · info: blue bg, info-circle icon
  · warning: amber bg, alert-triangle icon
  · error: red bg, x-circle icon
- Body: title (12px, 500) + subtitle (11px, muted, mt-0.5)
- Optional action buttons row (10px pills, mt-2)
- Progress bar (2px, colored, w-full → w-0 over 4s, mt-2)
- Close × button (top-right, 11px, muted)

useToast() hook: { success, info, warning, error } methods
Each accepts: { title, description, actions?: [{label, onClick}] }
```

---

## 使用说明

1. **v0.dev** — 复制任意 Prompt，粘贴到 v0.dev 输入框，选择 shadcn/ui 模式
2. **Cursor / Windsurf** — 在项目根目录打开对话，附上设计系统基础段 + 具体 Prompt
3. **Lovable** — 粘贴 Prompt，选择 React + Tailwind 模板
4. **Claude Cowork** — 直接对话，Claude 会基于已有原型继续扩展

> 建议每次生成时先附上「设计系统基础」段落，保证风格统一。
