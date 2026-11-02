'use client'

import React, { useRef, useState } from 'react'
import styles from './review.module.css'

export default function ReviewForm() {
  const fields = useRef<HTMLDivElement>(null)
  const [reviewed, setReviewed] = useState(false)

  function reviewLocally() {
    const controls = fields.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input:not([type="password"]), select, textarea',
    )
    for (const control of controls ?? []) {
      if (!control.reportValidity()) return
    }
    setReviewed(true)
  }

  return <section className={styles.card} aria-labelledby="application-heading">
    <div className={styles.cardHeader}><span className={styles.step}>02</span><div>
      <h2 id="application-heading">Try assisted form filling</h2>
      <p>Open ApplyMate → Form Filler → Scan current page.</p>
    </div></div>
    {/* A form landmark without a native submit action also stays safe before hydration. */}
    <div ref={fields} role="form" aria-labelledby="application-heading" className={styles.fields}>
      <div className={styles.fieldRow}>
        <label className={styles.field} htmlFor="first-name"><span>First name <span aria-hidden="true">*</span></span>
          <input id="first-name" name="firstName" autoComplete="given-name" placeholder="Alex" required />
        </label>
        <label className={styles.field} htmlFor="last-name"><span>Last name <span aria-hidden="true">*</span></span>
          <input id="last-name" name="lastName" autoComplete="family-name" placeholder="Morgan" required />
        </label>
      </div>
      <label className={styles.field} htmlFor="email"><span>Email address <span aria-hidden="true">*</span></span>
        <input id="email" name="email" type="email" autoComplete="email" placeholder="alex.morgan@example.com" required />
      </label>
      <div className={styles.fieldRow}>
        <label className={styles.field} htmlFor="location">Location
          <select id="location" name="location" defaultValue=""><option value="">Select a location</option><option>Dublin</option><option>Cork</option><option>Galway</option><option>Remote</option></select>
        </label>
        <label className={styles.field} htmlFor="availability">Available from
          <input id="availability" name="availableFrom" type="date" />
        </label>
      </div>
      <label className={styles.field} htmlFor="portfolio">Portfolio or GitHub URL
        <input id="portfolio" name="portfolio" type="url" placeholder="https://example.com/portfolio" />
      </label>
      <label className={styles.field} htmlFor="motivation">Why does this example role interest you?
        <textarea id="motivation" name="motivation" rows={3} placeholder="Use a fictional answer, or review an AI suggestion from your test profile." />
      </label>
      <label className={styles.field} htmlFor="resume"><span>Sample resume <span className={styles.optional}>(optional)</span></span>
        <input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx" />
      </label>
      <p className={styles.hint}>Use fictional details and a sample document. This page does not upload the selected file.</p>
      <button type="button" className={styles.reviewButton} onClick={reviewLocally}>Check form locally <span aria-hidden="true">→</span></button>
      <p role="status" aria-live="polite" className={reviewed ? styles.success : styles.hint}>
        {reviewed ? 'Local check complete. No application was submitted.' : 'There is no application submission action on this page.'}
      </p>
    </div>
  </section>
}
