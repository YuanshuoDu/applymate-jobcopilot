// ── Shared types across popup / sidepanel / background / content ──

export interface ExtensionSettings {
  apiBaseUrl: string    // e.g. http://localhost:3000
  apiToken:   string    // long-lived JWT from /api/auth/extension-token
  userEmail:  string
  userName:   string
  autoSave:   boolean   // auto-save when visiting a job page
}

export type JobStatus = 'saved' | 'applied' | 'review' | 'interview' | 'offer' | 'rejected'

export interface ScrapedJob {
  title:       string
  company:     string
  location:    string
  description: string
  salary:      string | null
  url:         string
  source:      'linkedin' | 'indeed' | 'glassdoor' | 'wellfound' | 'greenhouse' | 'lever' | 'workday' | 'stepstone' | 'xing' | 'smartrecruiters' | 'ashby' | 'bamboohr' | 'jobvite' | 'icims' | 'unknown'
}

export interface SavedJob {
  id:        string
  company:   string
  role:      string
  location:  string | null
  status:    JobStatus
  score:     number | null
  salary:    string | null
  notes:     string | null
  source:    string | null
  createdAt: string
  url:       string | null
}

export interface DashboardStats {
  total:      number
  applied:    number
  interviews: number
  offers:     number
}

// ── Resume types (mirrored from web app) ─────────────────────────

export interface ResumeContent {
  contact: {
    name:     string
    email:    string
    location: string
    linkedin?: string
    github?:  string
    website?: string
    phone?:   string
  }
  summary:    string
  experience: Array<{
    company: string
    role:    string
    period:  string
    bullets: string[]
  }>
  education: Array<{
    institution: string
    degree:      string
    year:        string
  }>
  skills: string[]
  languages?: Array<{ lang: string; level: string }>
  projects?: Array<{
    name:    string
    role?:   string
    period?: string
    url?:    string
    bullets: string[]
  }>
  certifications?: Array<{
    name:   string
    issuer: string
    date:   string
    url?:   string
  }>
  custom?: Array<{
    id:    string
    title: string
    items: Array<{
      title?:    string
      subtitle?: string
      period?:   string
      bullets:   string[]
    }>
  }>
  sectionOrder?: string[]
}

export interface TemplateOptions {
  accentColor?: string
  fontFamily?:  'serif' | 'sans' | 'mono'
  density?:     'compact' | 'comfortable' | 'spacious'
}

export interface ResumeListItem {
  id:        string
  name:      string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface Resume extends ResumeListItem {
  content:         ResumeContent
  templateId:      string | null
  templateOptions: TemplateOptions | null
}

// ── AI score / suggest types ─────────────────────────────────────

export interface SectionMatch {
  section:  string
  keywords: string[]
  score:    number
  tip:      string
}

export interface MissingItem {
  keyword: string
  target:  string
  tip:     string
}

export interface ScoreResult {
  score:            number
  matchedKeywords:  string[]
  sectionMatches:   SectionMatch[]
  missingItems:     MissingItem[]
  sectionScores:    Record<string, number>
  sectionTips:      Record<string, string>
  skillsGap:        string[]
  strengthSummary:  string
  _model?:          string
}

export interface Suggestion {
  text:     string
  target:   'summary' | 'skills' | 'experience' | 'education' | 'general'
  action:   'rewrite' | 'reorder' | 'enhance' | 'add_keywords' | 'none'
  proposed?: string
  applied:  boolean
}

// ── Message types (content ↔ background ↔ popup) ──────────────

export type ExtMessage =
  | { type: 'GET_CURRENT_JOB' }
  | { type: 'CURRENT_JOB_RESULT'; job: ScrapedJob | null }
  | { type: 'SAVE_JOB'; job: ScrapedJob }
  | { type: 'SAVE_JOB_RESULT'; success: boolean; savedJob?: SavedJob; error?: string }
  | { type: 'GET_STATS' }
  | { type: 'STATS_RESULT'; stats: DashboardStats }
  | { type: 'GET_RECENT_JOBS' }
  | { type: 'RECENT_JOBS_RESULT'; jobs: SavedJob[] }
  | { type: 'OPEN_SIDE_PANEL' }
  | { type: 'JOB_SCRAPED'; job: ScrapedJob }   // content → background when job detected
  | { type: 'ENRICH_JOB'; job: ScrapedJob }    // content → background: auto-patch saved job with description
  | { type: 'FETCH_DASHBOARD_TOKEN' }
  | { type: 'PING' }
  | { type: 'PONG' }
  // ── Form Filler ──
  | { type: 'FORM_DETECTED'; fields: import('./form-filler/types').FormFieldSchema[]; source: string; formCount: number }
  | { type: 'SCAN_FORM' }
  | { type: 'ANALYZE_FORM'; fields: import('./form-filler/types').FormFieldSchema[] }
  | { type: 'FORM_ANALYSIS_RESULT'; response: import('./form-filler/types').FormFillResponse }
  | { type: 'FORM_ANALYSIS_COMPLETE'; success: boolean }
  | { type: 'READ_FIELD_VALUES'; fieldIds: string[] }
  | { type: 'FIELD_VALUES_RESULT'; values: Array<{ fieldId: string; value: string }> }
  | { type: 'REVISE_FORM'; instruction: string }
  | { type: 'APPLY_FIELD_VALUES'; fields: import('./form-filler/types').FilledField[] }
  | { type: 'APPLY_RESULT'; success: boolean; failedFields: string[] }
