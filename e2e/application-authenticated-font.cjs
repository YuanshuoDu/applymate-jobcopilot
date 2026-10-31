// Next's test-only Google font response uses a repository-owned font file.
// The resulting test build is not evidence of production typography.
module.exports = {
  'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap': `
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(/workspace/apps/web/public/fonts/NotoSans-Regular.ttf) format('truetype');
}`,
}
