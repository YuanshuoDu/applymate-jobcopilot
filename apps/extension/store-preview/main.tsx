import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PopupMainView } from '../src/popup/MainView'
import { SidePanel } from '../src/sidepanel/SidePanel'
import { installPreviewPlatform } from './platform'
import { sampleJob, sampleSettings } from './fixtures'
import './preview.css'

installPreviewPlatform()

function StorePreview() {
  const [view, setView] = useState<'popup' | 'panel'>('popup')
  const [notice, setNotice] = useState('')
  const unavailable = () => setNotice('This preview uses fictional data. Sign in through the installed extension to use your account.')
  useEffect(() => {
    const root = document.getElementById('root')!
    const neutralizeLinks = () => {
      for (const anchor of root.querySelectorAll('a')) {
        if (anchor.getAttribute('href') !== '#') anchor.setAttribute('href', '#')
        anchor.removeAttribute('target')
        anchor.setAttribute('data-preview-link', 'disabled')
      }
    }
    const blockNavigation = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('a')) {
        event.preventDefault()
        setNotice('External navigation is disabled in this sample preview.')
      }
    }
    const observer = new MutationObserver(neutralizeLinks)
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'target'] })
    root.addEventListener('click', blockNavigation, true)
    root.addEventListener('auxclick', blockNavigation, true)
    neutralizeLinks()
    return () => {
      observer.disconnect()
      root.removeEventListener('click', blockNavigation, true)
      root.removeEventListener('auxclick', blockNavigation, true)
    }
  }, [])
  return <main className="store-canvas">
    <section className="store-copy">
      <div className="store-brand"><span>A</span> ApplyMate AI</div>
      <div className="store-eyebrow">YOUR JOB SEARCH, WITHIN REACH</div>
      <h1>{view === 'popup' ? <>A role worth<br />keeping.</> : <>Your next move,<br />in one place.</>}</h1>
      <p className="store-intro">{view === 'popup' ? 'Save the job you are viewing and keep the next steps close at hand.' : 'Organise saved roles, review your profile and prepare for each application.'}</p>
      <article className="sample-job" aria-label="Fictional job example">
        <div className="sample-label">FICTIONAL JOB EXAMPLE</div>
        <h2>{sampleJob.title}</h2>
        <p>{sampleJob.company} <span>·</span> {sampleJob.location}</p>
        <div className="sample-rule" />
        <p className="sample-description">{sampleJob.description}</p>
        <div className="sample-tags"><span>React</span><span>TypeScript</span><span>Accessibility</span></div>
      </article>
      <div className="store-note">Actual ApplyMate interface · Illustrative sample data<br />Component preview. No account, AI calls or real applications.</div>
    </section>
    <section className={`store-product ${view}`} aria-label="ApplyMate component preview">
      <nav className="preview-switch" aria-label="Preview surface">
        <button aria-pressed={view === 'popup'} onClick={() => { setView('popup'); setNotice('') }}>Popup</button>
        <button aria-pressed={view === 'panel'} onClick={() => { setView('panel'); setNotice('') }}>Side panel</button>
        <span>SAMPLE DATA</span>
      </nav>
      <div className="product-window">
        {view === 'popup' ? <PopupMainView settings={sampleSettings} onSettings={unavailable} onLogout={unavailable} /> : <SidePanel />}
      </div>
      {notice && <p className="preview-notice" role="status">{notice}</p>}
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<StorePreview />)
