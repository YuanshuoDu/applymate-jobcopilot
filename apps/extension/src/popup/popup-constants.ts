export const C = {
  primary: '#5146E5',
  navy: '#101A3A',
  muted: '#6B7898',
  subtle: '#8995B2',
  bg: '#F8F8FF',
  panel: '#FFFFFF',
  lavender: '#F0F0FF',
  border: '#E2E4F4',
  green: '#28A66F',
  greenBg: '#E8F7F0',
  shadow: '0 8px 24px rgba(42, 48, 105, 0.06)',
}

export type PopupLabels = {
  detected: string
  notDetected: string
  saveJob: string
  savedJob: string
  saveJobSub: string
  analyzeMatch: string
  analyzeMatchSub: string
  prepare: string
  prepareSub: string
  savedJobs: string
  openSidebar: string
  match: string
  strongFit: string
  readyToAnalyze: string
  noJobTitle: string
  noJobSub: string
  browseLinkedIn: string
  browseIndeed: string
  analyzeError: string
  noResume: string
  menuSettings: string
  menuDashboard: string
  menuSignOut: string
  sidePanelError: string
  settingsBack: string
  account: string
  signedIn: string
  preferences: string
  autoSave: string
  autoSaveSub: string
  manageAccount: string
  savedConfirm: string
}

export const LABELS: Record<string, PopupLabels> = {
  en: {
    detected: 'LinkedIn job page detected', notDetected: 'No job detected on this page',
    saveJob: 'Save job', savedJob: 'Saved job', saveJobSub: 'Add to your saved jobs',
    analyzeMatch: 'Analyze match', analyzeMatchSub: 'See role fit and key insights',
    prepare: 'Prepare application', prepareSub: 'Tailor resume, cover letter & talking points',
    savedJobs: 'Saved jobs', openSidebar: 'Open sidebar', match: 'Match', strongFit: 'Strong fit — ready to prepare.',
    readyToAnalyze: 'Ready to analyze this role.', noJobTitle: 'Open a job page to get started',
    noJobSub: 'ApplyMate will identify the role and make the next step clear.',
    browseLinkedIn: 'Browse LinkedIn jobs', browseIndeed: 'Browse Indeed jobs', analyzeError: 'Match analysis failed.',
    noResume: 'Add a resume in the Sidebar before analyzing.', menuSettings: 'Settings', menuDashboard: 'Open dashboard', menuSignOut: 'Sign out', sidePanelError: 'Chrome could not open the side panel. Use the Side panel button in the toolbar.',
    settingsBack: 'Back', account: 'Account', signedIn: 'Signed in', preferences: 'Preferences', autoSave: 'Automatically save jobs', autoSaveSub: 'Save detected jobs while you browse', manageAccount: 'Manage account', savedConfirm: 'Saved',
  },
}
