import puppeteer from 'puppeteer';

console.log('ApplyMate AI — LinkedIn + Full Test\n');

const extensionPath = 'F:\\\\ApplyMate\\\\ApplyMate AI\\\\jobcopilot\\\\apps\\\\extension\\\\dist';

const browser = await puppeteer.launch({
  headless: false,
  args: [
    '--no-first-run', '--no-default-browser-check',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
  defaultViewport: { width: 1280, height: 900 },
  protocolTimeout: 60000,
});

const page = await browser.newPage();
const extLogs = [];
page.on('console', msg => {
  const text = msg.text();
  if (text.includes('[ApplyMate]')) extLogs.push(text.slice(0, 250));
});

// ============================================================
// TEST: LinkedIn List Page — Real Job Detection
// ============================================================
console.log('═══ LINKEDIN JOB DETECTION TEST ═══\n');
await page.goto('https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer', {
  waitUntil: 'networkidle0', timeout: 30000
}).catch(() => {});

console.log('Waiting for LinkedIn to load...');
await new Promise(r => setTimeout(r, 8000));

console.log('Page title:', (await page.title()).slice(0, 100));

const liResult = await page.evaluate(() => {
  const r = {
    // NEW selectors (2026 LinkedIn)
    'div.base-card': document.querySelectorAll('.base-card').length,
    'h3.base-search-card__title': document.querySelectorAll('h3.base-search-card__title').length,
    'h4.base-search-card__subtitle': document.querySelectorAll('h4.base-search-card__subtitle').length,
    'span.job-search-card__location': document.querySelectorAll('span.job-search-card__location').length,
    'a.base-card__full-link': document.querySelectorAll('a.base-card__full-link').length,
    // Extension injected?
    'extButtons': document.querySelectorAll('.applymate-card-btn').length,
    // OLD selectors (for comparison)
    'li[data-occludable-job-id]': document.querySelectorAll('li[data-occludable-job-id]').length,
    'li[data-job-id]': document.querySelectorAll('li[data-job-id]').length,
    // Login check
    'loginForm': !!document.querySelector('#username, .sign-in-form'),
  };

  // Scrape first card with new selectors
  const card = document.querySelector('.base-card');
  if (card) {
    r.firstCard = {
      title: card.querySelector('h3.base-search-card__title')?.innerText?.trim(),
      company: card.querySelector('h4.base-search-card__subtitle')?.innerText?.trim(),
      location: card.querySelector('span.job-search-card__location')?.innerText?.trim(),
      link: card.querySelector('a.base-card__full-link')?.href?.slice(0, 120),
    };
  }
  return r;
});

console.log('\nLinkedIn DOM Analysis:');
console.log('  div.base-card:', liResult['div.base-card']);
console.log('  h3.base-search-card__title:', liResult['h3.base-search-card__title']);
console.log('  a.base-card__full-link:', liResult['a.base-card__full-link']);
console.log('  Extension ⊕ buttons:', liResult.extButtons);
console.log('  Login wall:', liResult.loginForm);
console.log('  OLD selectors (should be 0):', liResult['li[data-occludable-job-id]'], liResult['li[data-job-id]']);

if (liResult.firstCard) {
  console.log('\n  First card scrape:');
  console.log('    Title:', liResult.firstCard.title);
  console.log('    Company:', liResult.firstCard.company);
  console.log('    Location:', liResult.firstCard.location);
}

console.log('\nExtension logs from LinkedIn:');
extLogs.filter(l => l.includes('linkedin') || l.includes('LIST') || l.includes('Processing')).forEach(l => console.log('  ', l));

// ============================================================
// RESULTS
// ============================================================
console.log('\n═══════════════════════════════════════');
if (liResult['div.base-card'] > 0) {
  console.log('  ✅ LinkedIn jobs DETECTED:', liResult['div.base-card'], 'cards');
  console.log('  ✅ New selectors WORKING');
} else {
  console.log('  ❌ LinkedIn jobs NOT detected');
}
if (liResult.extButtons > 0) {
  console.log('  ✅ Extension buttons INJECTED:', liResult.extButtons);
} else {
  console.log('  ⚠️  Extension buttons not injected yet');
  console.log('     (may need logged-in LinkedIn or longer wait)');
}
console.log('═══════════════════════════════════════\n');

await browser.close();
