export type JobApiProvider = {
  key: string
  label: string
  access: 'platform' | 'byok' | 'public' | 'future'
  maxJobsPerResponse?: number
  fullJobData?: boolean
}

export const JOB_API_PROVIDERS: readonly JobApiProvider[] = [
  { key: 'cleanjobdata', label: 'CleanJobData', access: 'platform', maxJobsPerResponse: 20, fullJobData: true },
  { key: 'fantasticjobs', label: 'Fantastic Jobs', access: 'platform', maxJobsPerResponse: 20, fullJobData: true },
  { key: 'ashby', label: 'Ashby', access: 'public', fullJobData: true },
  { key: 'adzuna', label: 'Adzuna', access: 'byok' },
  { key: 'rapidapi-jsearch', label: 'RapidAPI · JSearch', access: 'byok' },
  { key: 'rapidapi-linkedin', label: 'RapidAPI · LinkedIn Jobs', access: 'byok' },
  { key: 'rapidapi-active-jobs', label: 'RapidAPI · Active Jobs DB', access: 'byok' },
  { key: 'rapidapi-jobs-api14', label: 'RapidAPI · Jobs API 14', access: 'byok' },
  { key: 'rapidapi-internships', label: 'RapidAPI · Internships', access: 'byok' },
  { key: 'mantiks', label: 'Mantiks', access: 'platform' },
  { key: 'reed', label: 'Reed', access: 'platform' },
  { key: 'careerjet', label: 'CareerJet', access: 'platform' },
  { key: 'greenhouse', label: 'Greenhouse', access: 'public' },
  { key: 'lever', label: 'Lever', access: 'public' },
  { key: 'workday', label: 'Workday', access: 'public' },
  { key: 'smartrecruiters', label: 'SmartRecruiters', access: 'public' },
  { key: 'personio', label: 'Personio', access: 'public' },
  { key: 'jobicy', label: 'Jobicy', access: 'public' },
  { key: 'remotive', label: 'Remotive', access: 'public' },
  { key: 'bundesagentur', label: 'Bundesagentur', access: 'public' },
  { key: 'irishjobs', label: 'IrishJobs', access: 'public' },
] as const

const providerKeys = new Set(JOB_API_PROVIDERS.map(provider => provider.key))

export function isJobApiProvider(value: string): boolean {
  return providerKeys.has(value)
}

export function jobApiProviderLabel(value: string): string {
  return JOB_API_PROVIDERS.find(provider => provider.key === value)?.label ?? value
}
