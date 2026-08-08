export const ATS_POLICIES = {
  greenhouse: { host: "boards-api.greenhouse.io", rps: 5 },
  lever: { host: "api.lever.co", rps: 5 },
  workday: { host: "myworkdayjobs.com", rps: 1 },
  smartrecruiters: { host: "api.smartrecruiters.com", rps: 5 },
  personio: { host: "jobs.personio.com", rps: 5 },
} as const;

export type AtsSourceKey = keyof typeof ATS_POLICIES;

export type DefaultAtsPolicy = {
  state: "enabled";
  enabled: true;
  rolloutPercent: 100;
  globalRpsLimit: number;
  perTenantRpsLimit: number;
  maxRetries: 0;
  backoffBaseMs: 1_000;
  allowAutoApply: true;
};

export function isAtsSourceKey(value: string): value is AtsSourceKey {
  return Object.hasOwn(ATS_POLICIES, value);
}

export function getHardRpsLimit(sourceKey: string): number | null {
  return isAtsSourceKey(sourceKey) ? ATS_POLICIES[sourceKey].rps : null;
}

/** Current behavior before an administrator persists an ATS-specific policy. */
export function getDefaultAtsPolicy(sourceKey: AtsSourceKey): DefaultAtsPolicy {
  const globalRpsLimit = Math.min(ATS_POLICIES[sourceKey].rps, 4);
  return {
    state: "enabled",
    enabled: true,
    rolloutPercent: 100,
    globalRpsLimit,
    perTenantRpsLimit: globalRpsLimit,
    maxRetries: 0,
    backoffBaseMs: 1_000,
    allowAutoApply: true,
  };
}
