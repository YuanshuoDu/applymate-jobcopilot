/** Public, fictional data. This page never represents an actual vacancy. */
export const REVIEW_JOB = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Junior Frontend Developer — fictional review role',
  hiringOrganization: { '@type': 'Organization', name: 'Example Studio (fictional)' },
  jobLocation: {
    '@type': 'Place',
    address: { '@type': 'PostalAddress', addressLocality: 'Dublin', addressCountry: 'IE' },
  },
  employmentType: 'FULL_TIME',
  description: 'This is a fictional job used to review the ApplyMate Chrome extension. No employer is recruiting through this page and no application will be submitted. In this example role, a junior frontend developer would build accessible React interfaces, work with TypeScript and REST APIs, investigate UI defects, and collaborate with designers. Example requirements include HTML, CSS, JavaScript, Git, and clear written communication. The sample application asks for contact details, a portfolio, availability, and a short motivation statement. Use fictional candidate information only.',
} as const

/** Escaping less-than signs keeps JSON-LD safe inside an inline script. */
export function reviewJobJsonLd(): string {
  return JSON.stringify(REVIEW_JOB).replace(/</g, '\\u003c')
}
