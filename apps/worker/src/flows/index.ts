export type FlowType = "greenhouse" | "workday" | "lever" | null;

export function detectFlow(url: string): FlowType {
  if (/boards\.greenhouse\.io|grnh\.se|greenhouse\.io\/applications/i.test(url)) return "greenhouse";
  if (/\.myworkdayjobs\.com/i.test(url)) return "workday";
  if (/jobs\.lever\.co|jobs\.eu\.lever\.co/i.test(url)) return "lever";
  return null;
}
