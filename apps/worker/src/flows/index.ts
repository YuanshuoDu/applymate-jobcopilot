export type FlowType = "greenhouse" | "workday" | null;

export function detectFlow(url: string): FlowType {
  if (/boards\.greenhouse\.io|grnh\.se|greenhouse\.io\/applications/i.test(url)) return "greenhouse";
  if (/\.myworkdayjobs\.com/i.test(url)) return "workday";
  return null;
}