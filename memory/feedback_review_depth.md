---
name: feedback-review-depth
description: PM review reports must include substantive analysis of whether code serves project goals, not just mechanical AC checking
metadata:
  type: feedback
---

PM review reports must go beyond mechanical AC pass/fail checking.

**Why:** User expects PM judgment on whether the implementation truly serves the product goals — business value, architecture soundness, risks, technical debt.

**How to apply:** Every review comment and user-facing report must include a "Code vs Project Goals" section with:
- **优点**: Which specific design decisions directly serve business value (e.g., descriptionPlain skips enrichment LLM = cost saved)
- **风险**: Acceptable temporary issues, when they'll be resolved
- **技术债**: Duplicate code, architecture concerns, design inconsistencies  
- **总体评价**: Whether the implementation effectively advances project goals

Do NOT report only the mechanical AC table. That's necessary but insufficient.
