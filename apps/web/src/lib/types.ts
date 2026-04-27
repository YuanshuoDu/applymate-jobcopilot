// ─────────────────────────────────────────────────────────────────────────────
// Domain types — kept in sync with prisma/schema.prisma
// ─────────────────────────────────────────────────────────────────────────────

export type JobStatus = 'saved' | 'applied' | 'review' | 'interview' | 'offer' | 'rejected'
export type Plan = 'free' | 'pro' | 'enterprise'

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
  notes:       string | null
  appliedAt:   string | null  // ISO date string from API
  followUpAt:  string | null
  createdAt:   string
  updatedAt:   string
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
}

export interface Resume extends ResumeListItem {
  content:    ResumeContent
  templateId: string | null
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
}

// ── User ───────────────────────────────────────────────────────────────────────
export interface UserProfile {
  id:        string
  email:     string
  name:      string | null
  image:     string | null
  plan:      Plan
  createdAt: string
}

// ── Pagination wrapper ─────────────────────────────────────────────────────────
export interface Paginated<T> {
  items:    T[]
  total:    number
  page:     number
  pageSize: number
}

// ── Resume AI types ───────────────────────────────────────────────────────────
export interface ScoreResult {
  score:           number
  matchedKeywords: string[]
  missingKeywords: string[]
  sectionScores:   Record<string, number>
  sectionTips:     Record<string, string>
}

export interface Suggestion { text: string; applied: boolean }

// ── UI-only ────────────────────────────────────────────────────────────────────
export type Page =
  | 'dashboard'
  | 'jobs'
  | 'resume'
  | 'gmail'
  | 'agent'
  | 'animation'
  | 'extension'
  | 'settings'
