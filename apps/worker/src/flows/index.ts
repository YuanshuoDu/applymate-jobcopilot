export type FlowType = "greenhouse" | "workday" | "lever" | "smartrecruiters" | "personio" | null;

export function detectFlow(url: string): FlowType {
  // Order matters: keep specific ATS hostnames before broader jobs.* patterns.
  if (/jobs\.smartrecruiters\.com/i.test(url)) return "smartrecruiters";
  if (/\.jobs\.personio\.com/i.test(url)) return "personio";
  if (/boards\.greenhouse\.io|grnh\.se|greenhouse\.io\/applications/i.test(url)) return "greenhouse";
  if (/\.myworkdayjobs\.com/i.test(url)) return "workday";
  if (/jobs\.lever\.co|jobs\.eu\.lever\.co/i.test(url)) return "lever";
  return null;
}
