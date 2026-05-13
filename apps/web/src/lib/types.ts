// ─────────────────────────────────────────────────────────────────────────────
// Domain types — kept in sync with prisma/schema.prisma
// ─────────────────────────────────────────────────────────────────────────────

export type JobStatus     = 'saved' | 'applied' | 'review' | 'interview' | 'offer' | 'rejected'
export type Plan          = 'free' | 'pro' | 'enterprise'
export type AgentRoleType = 'scout' | 'analyst' | 'writer' | 'reviewer' | 'executor' | 'auditor'

// ── AgentRole ─────────────────────────────────────────────────────────────────
export interface AgentRole {
  id:           string
  userId:       string
  role:         AgentRoleType
  enabled:      boolean
  provider:     string
  model:        string
  apiKey:       string | null
  systemPrompt: string | null
  lastRunAt:    string | null  // ISO date
  lastResult:   { count: number; durationMs: number; summary: string } | null
  totalRuns:    number
  createdAt:    string
  updatedAt:    string
}

export type ActivityType =
  | 'applied'
  | 'interview_scheduled'
  | 'offer_received'
  | 'rejected'
  | 'email_sent'
  | 'agent_action'
  | 'resume_tailored'
  | 'status_changed'
  | 'note_added'

// ── Job ───────────────────────────────────────────────────────────────────────
export interface Job {
  id:          string
  userId:      string
  company:     string
  logo:        string | null
  role:        string
  location:    string | null
  status:      JobStatus
  score:       number | null
  url:         string | null
  description: string | null
  salary:      string | null
  source:      string | null
  notes:        string | null
  coverLetter:  string | null
  analysisNote: string | null
  appliedAt:    string | null  // ISO date string from API
  followUpAt:   string | null
  createdAt:    string
  updatedAt:    string
}

// ── Activity ──────────────────────────────────────────────────────────────────
export interface Activity {
  id:        string
  userId:    string
  jobId:     string | null
  type:      ActivityType
  text:      string
  color:     string | null
  createdAt: string
  job?:      { company: string; role: string } | null
}

// ── Resume ────────────────────────────────────────────────────────────────────
export interface ResumeListItem {
  id:        string
  name:      string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

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
  accentColor?: string   // hex, from preset palette
  fontFamily?:  'serif' | 'sans' | 'mono'
  density?:     'compact' | 'comfortable' | 'spacious'
}

export interface Resume extends ResumeListItem {
  content:         ResumeContent
  templateId:      string | null
  templateOptions: TemplateOptions | null
}

// ── Agent Config ───────────────────────────────────────────────────────────────
export interface AgentConfig {
  id:               string
  userId:           string
  isRunning:        boolean
  dailyLimit:       number
  minMatchScore:    number
  autoApply:        boolean
  requireApproval:  boolean
  targetLocations:  string[]
  targetRoles:      string[]
  excludeCompanies: string[]
  model:            string
  createdAt:        string
  updatedAt:        string
}

// ── Dashboard API response ─────────────────────────────────────────────────────
export interface DashboardData {
  stats: {
    total:      number
    applied:    number
    inReview:   number
    interviews: number
    offers:     number
    thisWeek:   number
  }
  pipeline:    Record<JobStatus, number>
  recentJobs:  Job[]
  activity:    Activity[]
  agentConfig: AgentConfig | null
  hasResume:   boolean
}

// ── User ───────────────────────────────────────────────────────────────────────
export interface UserProfile {
  id:          string
  email:       string
  name:        string | null
  image:       string | null
  plan:        Plan
  phone:       string | null
  location:    string | null
  linkedin:    string | null
  github:      string | null
  preferences: UserPreferences | null
  createdAt:   string
}

export interface UserPreferences {
  targetRoles:       string
  targetLocations:   string
  salaryExpectation: string
  workAuthorization: string
  openToRelocation:  boolean
}

// ── Pagination wrapper ─────────────────────────────────────────────────────────
export interface Paginated<T> {
  items:    T[]
  total:    number
  page:     number
  pageSize: number
}

// ── Resume AI types ───────────────────────────────────────────────────────────

export interface MissingItem {
  keyword: string       // the keyword/phrase to add
  target:  string       // which section: "skills" | "summary" | "experience" | "projects"
  tip:     string       // short guidance, e.g. "mention in summary" | "add to skills" | "cite in experience bullet"
}

export interface SectionMatch {
  section:  string
  keywords: string[]     // what matched in this section
  score:    number       // 0-100 sub-score
  tip:      string       // improvement guidance
}

export interface ScoreResult {
  score:           number
  matchedKeywords: string[]
  missingItems:    MissingItem[]    // per-section missing items (replaces flat missingKeywords)
  sectionMatches:  SectionMatch[]   // per-section matched analysis
  sectionScores:   Record<string, number>
  sectionTips:     Record<string, string>
  strengthSummary: string
  skillsGap:       string[]
}

export interface Suggestion {
  text:     string
  target:   'summary' | 'skills' | 'experience' | 'education' | 'general'
  action:   'rewrite' | 'reorder' | 'enhance' | 'add_keywords' | 'none'
  proposed?: string
  applied:  boolean
}

// ── UI-only ────────────────────────────────────────────────────────────────────
export type Page =
  | 'dashboard'
  | 'jobs'
  | 'search'
  | 'resume'
  | 'gmail'
  | 'agent'
  | 'animation'
  | 'extension'
  | 'settings'
