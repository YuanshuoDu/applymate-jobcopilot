import React from 'react'
import type { Metadata } from 'next'
import styles from '../review.module.css'

export const metadata: Metadata = {
  title: 'ApplyMate review — fictional embedded questions',
  robots: { index: false, follow: false },
}

export default function ReviewFramePage() {
  return <main className={styles.frameContent}>
    <p className={styles.frameNote}>Fictional embedded questions · No submission</p>
    <div role="form" aria-label="Embedded demo questions" className={styles.fields}>
      <div className={styles.fieldRow}>
        <label className={styles.field} htmlFor="work-authorisation">Work authorisation in Ireland
          <select id="work-authorisation" name="workAuthorisation" defaultValue=""><option value="">Choose a sample answer</option><option>Authorised to work</option><option>Requires sponsorship</option><option>Prefer to discuss</option></select>
        </label>
        <label className={styles.field} htmlFor="notice-period">Notice period
          <select id="notice-period" name="noticePeriod" defaultValue=""><option value="">Choose a sample answer</option><option>Immediately</option><option>Two weeks</option><option>One month</option></select>
        </label>
      </div>
      <label className={styles.field} htmlFor="example-project">Describe a relevant sample project
        <textarea id="example-project" name="exampleProject" rows={3} placeholder="Use fictional project details to test this separate frame." />
      </label>
    </div>
  </main>
}
