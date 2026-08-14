export const metadata = {
  title: 'Privacy Policy | ApplyMate AI',
  description: 'How ApplyMate AI handles account, job, resume, form, and extension data.',
}

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '56px 24px 80px', color: '#172033', fontFamily: 'system-ui, sans-serif', lineHeight: 1.65 }}>
      <p style={{ color: '#4f46e5', fontWeight: 700, letterSpacing: '.04em' }}>APPLYMATE AI</p>
      <h1 style={{ fontSize: 36, lineHeight: 1.15, margin: '10px 0 12px' }}>Privacy Policy</h1>
      <p style={{ color: '#526078' }}>Effective date: 14 August 2026</p>

      <h2>What this policy covers</h2>
      <p>ApplyMate AI helps candidates save job postings, organise applications, tailor resumes, and review assisted form-fill suggestions. This policy covers the ApplyMate website, API, and Chrome extension.</p>

      <h2>Data we handle</h2>
      <ul>
        <li>Account details such as name, email address, authentication records, and plan status.</li>
        <li>Job-page content that you choose to save, including job title, company, location, URL, salary, and description.</li>
        <li>Resumes, Persona profile facts, cover letters, application answers, and form fields that you choose to use.</li>
        <li>Extension settings, extension authentication state, supported-page URLs, and basic operational diagnostics.</li>
      </ul>

      <h2>How we use data</h2>
      <p>We use this data only to provide the user-facing ApplyMate features you request: saving and tracking jobs, generating or revising application materials, matching your profile to a job, and filling application forms for your review. The extension reads supported job pages and, when you grant optional site access and start a form scan, the specific company or ATS page you selected.</p>

      <h2>Sharing and limited use</h2>
      <p>Data is sent to ApplyMate services over HTTPS. When you request an AI feature, the relevant job, resume, Persona, or form information may be processed by the configured AI provider to return that feature’s result. We do not sell personal data, use it for personalised advertising, or use it for advertising attribution.</p>
      <p>ApplyMate follows the Chrome Web Store User Data Policy, including its Limited Use requirements. Human access to user content is prohibited except with your specific consent, where necessary for security, to comply with law, or for aggregated and anonymised operations.</p>

      <h2>Security and retention</h2>
      <p>Authentication and API traffic use HTTPS in production. Extension tokens are scoped to the ApplyMate account and can be invalidated by signing out or changing account security state. You can manage, export, or delete your account data through the product where those controls are available, or contact us for assistance.</p>

      <h2>Your choices</h2>
      <p>You choose whether to save a job, send material to an AI feature, fill a form, or save a new Persona fact. The extension fills fields for your review; it does not submit an application on your behalf.</p>

      <h2>Contact</h2>
      <p>For privacy questions or data requests, email <a href="mailto:legal@applymate.ai">legal@applymate.ai</a>.</p>
    </main>
  )
}
