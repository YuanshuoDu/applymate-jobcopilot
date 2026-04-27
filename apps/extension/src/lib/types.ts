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
  source:      'linkedin' | 'indeed' | 'glassdoor' | 'wellfound' | 'greenhouse' | 'lever' | 'workday' | 'stepstone' | 'xing' | 'unknown'
}

export interface SavedJob {
  id:        string
  company:   string
  role:      string
  location:  string | null
  status:    JobStatus
  score:     number | null
  salary:    string | null
  createdAt: string
  url:       string | null
}

export interface DashboardStats {
  total:      number
  applied:    number
  interviews: number
  offers:     number
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
  | { type: 'PING' }
  | { type: 'PONG' }
