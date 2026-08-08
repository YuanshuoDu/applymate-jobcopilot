export const ATS_POLICIES = {
  greenhouse: { host: "boards-api.greenhouse.io", rps: 5 },
  lever: { host: "api.lever.co", rps: 5 },
  workday: { host: "myworkdayjobs.com", rps: 1 },
  smartrecruiters: { host: "api.smartrecruiters.com", rps: 5 },
  personio: { host: "jobs.personio.com", rps: 5 },
} as const;

export type AtsSourceKey = keyof typeof ATS_POLICIES;

export function isAtsSourceKey(value: string): value is AtsSourceKey {
  return Object.hasOwn(ATS_POLICIES, value);
}

export function getHardRpsLimit(sourceKey: string): number | null {
  return isAtsSourceKey(sourceKey) ? ATS_POLICIES[sourceKey].rps : null;
}
