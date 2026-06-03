export type FlowType = "greenhouse" | "workday" | "lever" | "smartrecruiters" | null;

export function detectFlow(url: string): FlowType {
  if (/boards\.greenhouse\.io|grnh\.se|greenhouse\.io\/applications/i.test(url)) return "greenhouse";
  if (/\.myworkdayjobs\.com/i.test(url)) return "workday";
  if (/jobs\.lever\.co|jobs\.eu\.lever\.co/i.test(url)) return "lever";
  if (/jobs\.smartrecruiters\.com/i.test(url)) return "smartrecruiters";
  return null;
}
