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
  syncedWorkspace: string
  aiReviewing: string
  yourAiJobCopilot: string
  accountMenu: string
  waitingBrowserLogin: string
  cancel: string
  goodFit: string
  reviewCarefully: string
  detectedLabel: string
  notDetectedLabel: string
  emailPlaceholder: string
  language: string
  english: string
  chinese: string
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
    settingsBack: 'Back', account: 'Account', accountMenu: 'Account menu', signedIn: 'Signed in', preferences: 'Preferences', autoSave: 'Automatically save jobs', autoSaveSub: 'Save detected jobs while you browse', manageAccount: 'Manage account', savedConfirm: 'Saved', syncedWorkspace: 'Synced to your ApplyMate workspace', aiReviewing: 'AI is reviewing your profile…', yourAiJobCopilot: 'Your AI job copilot', waitingBrowserLogin: 'Waiting for login in browser tab…', cancel: 'Cancel', goodFit: 'Good fit — review the role details.', reviewCarefully: 'Review this role carefully before applying.', detectedLabel: 'Detected', notDetectedLabel: 'Not detected', emailPlaceholder: 'you@example.com', language: 'Language', english: 'English', chinese: '中文',
  },
  zh: {
    detected: '已识别 LinkedIn 职位页面', notDetected: '此页面未识别到职位',
    saveJob: '保存职位', savedJob: '已保存职位', saveJobSub: '添加到已保存职位',
    analyzeMatch: '分析匹配度', analyzeMatchSub: '查看职位匹配和关键洞察',
    prepare: '准备申请', prepareSub: '定制简历、求职信和面试要点',
    savedJobs: '已保存职位', openSidebar: '打开侧边栏', match: '匹配度', strongFit: '匹配度很高，可以开始准备。',
    readyToAnalyze: '可以开始分析这个职位。', noJobTitle: '打开职位页面开始使用',
    noJobSub: 'ApplyMate 会识别职位，并告诉你下一步该做什么。',
    browseLinkedIn: '浏览 LinkedIn 职位', browseIndeed: '浏览 Indeed 职位', analyzeError: '匹配分析失败。',
    noResume: '请先在侧边栏添加简历，再进行分析。', menuSettings: '设置', menuDashboard: '打开控制台', menuSignOut: '退出登录', sidePanelError: 'Chrome 无法打开侧边栏，请使用浏览器工具栏中的侧边栏按钮。',
    settingsBack: '返回', account: '账户', accountMenu: '账户菜单', signedIn: '已登录', preferences: '偏好设置', autoSave: '自动保存职位', autoSaveSub: '浏览职位页面时自动保存识别结果', manageAccount: '管理账户', savedConfirm: '已保存', syncedWorkspace: '已同步到你的 ApplyMate 工作区', aiReviewing: 'AI 正在分析你的画像……', yourAiJobCopilot: '你的 AI 求职助手', waitingBrowserLogin: '等待浏览器标签页登录……', cancel: '取消', goodFit: '匹配度不错，请查看职位详情。', reviewCarefully: '申请前请仔细审核该职位。', detectedLabel: '已识别', notDetectedLabel: '未识别', emailPlaceholder: '你的邮箱@example.com', language: '语言', english: 'English', chinese: '中文',
  },
}
