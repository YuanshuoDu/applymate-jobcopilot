import React from 'react'
import type { Metadata } from 'next'
import ReviewForm from './ReviewForm'
import { reviewJobJsonLd } from './review-fixture'
import styles from './review.module.css'

export const metadata: Metadata = {
  title: 'ApplyMate extension review — fictional job',
  description: 'A fictional job and application page for testing the ApplyMate Chrome extension. No applications are submitted.',
  robots: { index: false, follow: false },
}

export default function ExtensionReviewPage() {
  return <main className={styles.page}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: reviewJobJsonLd() }} />
    <header className={styles.header}>
      <a className={styles.brand} href="/landing"><span className={styles.brandIcon} aria-hidden="true">A</span> ApplyMate <span className={styles.reviewTag}>Extension review</span></a>
      <nav aria-label="Review navigation"><a href="/privacy">Privacy</a><a href="/login?callbackUrl=%2Fextension-review">Sign in to ApplyMate</a></nav>
    </header>
    <section className={styles.intro}>
      <span className={styles.eyebrow}>YOUR REVIEW PLAYGROUND</span>
      <h1>A job page. A form. Your copilot.</h1>
      <p>Try saving a role and reviewing form answers with the real ApplyMate extension.</p>
    </section>
    <div className={styles.notice} role="note"><strong>Fictional example.</strong> Example Studio is not recruiting. Use sample data only. This page has no employer submission endpoint. Saving a job or using AI in the extension uses your normal account, permissions, and data settings.</div>
    <div className={styles.grid}>
      <div className={styles.column}>
        <article className={styles.card} aria-labelledby="job-title">
          <div className={styles.cardHeader}><span className={styles.step}>01</span><div><h2>Save the example role</h2><p>Keep this job in your ApplyMate workspace.</p></div></div>
          <div className={styles.jobHead}><span className={styles.companyIcon} aria-hidden="true">EX</span><div><p className={styles.company}>Example Studio <span>· Fictional employer</span></p><h3 id="job-title">Junior Frontend Developer</h3></div></div>
          <div className={styles.tags}><span>Dublin, Ireland</span><span>Full time · Demo</span><span>Entry level</span></div>
          <p className={styles.jobDescription}>A fictional role for someone who enjoys making useful, accessible web interfaces and learning how products work.</p>
          <h4>In this example role, you would</h4>
          <ul className={styles.jobList}><li>Build responsive interfaces with React and TypeScript.</li><li>Connect UI components to REST APIs.</li><li>Investigate defects and improve accessibility.</li><li>Work with designers and document your decisions.</li></ul>
          <h4>Example skills</h4>
          <div className={styles.skillTags}><span>React</span><span>TypeScript</span><span>HTML & CSS</span><span>Git</span></div>
          <a className={styles.jumpLink} href="#application-heading">Try the sample application <span aria-hidden="true">↗</span></a>
        </article>
        <details className={styles.instructions}>
          <summary>Review steps and test limits</summary>
          <ol><li>Sign in using a normal ApplyMate test account. No special login bypass is provided.</li><li>Open the extension. Save this fictional role, then inspect it in your job tracker.</li><li>Open Form Filler, grant the site access you want, and scan. Review suggested values before applying them.</li><li>Try the embedded questions below to check that fields stay associated with the right frame.</li><li>The local check button never submits an application. AI and saved-account features still require their normal permissions and available credits.</li></ol>
          <p>Use a fictional profile, such as Alex Morgan and alex.morgan@example.com. Delete any saved demo role after review.</p>
        </details>
      </div>
      <ReviewForm />
    </div>
    <section className={styles.embedded} aria-labelledby="embedded-heading"><div className={styles.cardHeader}><span className={styles.step}>03</span><div><h2 id="embedded-heading">Embedded application questions</h2><p>A separate, same-site frame for checking multi-frame form filling.</p></div></div>
      <iframe src="/extension-review/frame" title="Fictional embedded application questions" className={styles.frame} />
    </section>
    <footer className={styles.footer}>ApplyMate extension review · Fictional data only · <a href="/privacy">Privacy & data use</a></footer>
  </main>
}
