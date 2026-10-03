/**
 * Marketing copy for the public landing page.
 *
 * Every claim here maps to something the platform actually ships:
 * spiders in app/scraper/spiders, extractors in app/extractors, the two-phase
 * match in app/services/job_match_orchestrator.py, the résumé/cover-letter
 * compiler in app/services/resume_builder_service.py, and the autofill engines
 * registered in extension/src/engines.js.
 */

export type LandingSectionId = 'how-it-works' | 'features' | 'autofill' | 'faq';

export const NAV_LINKS: { id: LandingSectionId; label: string }[] = [
  { id: 'how-it-works', label: 'How it works' },
  { id: 'features', label: 'Platform' },
  { id: 'autofill', label: 'Autofill' },
  { id: 'faq', label: 'FAQ' },
];

/** Job networks crawled by the scheduled spiders. */
export const JOB_SOURCES = [
  'Adzuna',
  'Jobright',
  'RemoteRocketship',
  'Welcome to the Jungle',
  'ZipRecruiter',
];

/** Application platforms with a dedicated autofill engine. */
export const ATS_PLATFORMS = [
  'Workday',
  'Greenhouse',
  'Lever',
  'Ashby',
  'Workable',
  'iCIMS',
  'SmartRecruiters',
  'Jobvite',
  'Breezy',
  'Pinpoint',
  'Manatal',
  'JobDiva',
  'ApplyToJob',
  'RecruiterFlow',
];

export const HERO_STATS = [
  { value: '5', label: 'job networks', hint: 'synced on your schedule' },
  { value: '14', label: 'ATS platforms', hint: 'filled field by field' },
  { value: '2', label: 'phase AI review', hint: 'score, then tailor' },
  { value: '3', label: 'AI providers', hint: 'OpenAI · Claude · Gemini' },
];

export type Step = {
  step: string;
  title: string;
  body: string;
  detail: string;
};

export const STEPS: Step[] = [
  {
    step: '01',
    title: 'Sync fresh roles',
    body: 'Scheduled crawlers sweep five job networks inside the posting window you choose, then clean, de-duplicate and drop anything stale before it reaches your board.',
    detail: 'Adzuna · Jobright · RemoteRocketship · Welcome to the Jungle · ZipRecruiter',
  },
  {
    step: '02',
    title: 'Read the real posting',
    body: 'ATS-native readers pull the full description straight from the source. Unusual pages fall back to HTML parsing and a headless browser, so the text is never a truncated preview.',
    detail: 'Greenhouse · Lever · Ashby · Workable · Workday · Algolia · HTML · Browser',
  },
  {
    step: '03',
    title: 'Score it against you',
    body: 'Phase A validates the posting, structures it, and scores the fit against your profile and written preferences. Anything under your minimum score never clutters your list.',
    detail: 'Match score · work mode · location · your own exclusion rules',
  },
  {
    step: '04',
    title: 'Tailor the documents',
    body: 'Phase B rewrites your résumé content for that specific role and drafts the cover letter, then compiles both into the template you designed as DOCX and PDF.',
    detail: 'Your template · your wording rules · versioned résumé library',
  },
  {
    step: '05',
    title: 'Apply in one pass',
    body: 'Open the Chrome side panel on the application page. The engine fills every field, answers screening questions from your profile, attaches the tailored résumé, and lines up the next job.',
    detail: 'Field-level autofill · screening answers · attachments · queue',
  },
];

export type Feature = {
  icon:
    | 'radar'
    | 'target'
    | 'layout'
    | 'wand'
    | 'activity'
    | 'shield'
    | 'bot'
    | 'plug'
    | 'chart';
  title: string;
  body: string;
};

export const FEATURES: Feature[] = [
  {
    icon: 'radar',
    title: 'Sourcing that runs without you',
    body: 'Spiders crawl on a schedule, respect posted-date windows, survive bot walls, and hand off clean postings. You open the app to new matches, not to a search box.',
  },
  {
    icon: 'target',
    title: 'Match scoring with your rules',
    body: 'Set a minimum score, describe what you want in plain language, and let the analysis hide the noise. Every score comes with the reasoning behind it.',
  },
  {
    icon: 'layout',
    title: 'A résumé builder you control',
    body: 'Design the template once: themes, typography, colour, sections, header image. Every tailored résumé compiles into that exact design, never a generic export.',
  },
  {
    icon: 'wand',
    title: 'Cover letters that stay yours',
    body: 'The AI writes only the body. Your letterhead, greeting and signature come from your own template, so the letter looks like you wrote it in your own file.',
  },
  {
    icon: 'activity',
    title: 'A pipeline you can watch live',
    body: 'Extraction, scoring, tailoring and document builds stream to the dashboard over websockets, so you always know which stage a job is in.',
  },
  {
    icon: 'shield',
    title: 'Duplicate and repeat guards',
    body: 'Company policies, a recycle window and applied-company rules stop you re-applying to the same role or spamming a company you already contacted.',
  },
  {
    icon: 'bot',
    title: 'An assistant that acts',
    body: 'Ask for remote roles above 80 and your board re-filters. The assistant runs real actions on your data and asks for confirmation before anything changes.',
  },
  {
    icon: 'plug',
    title: 'Your keys, your models',
    body: 'Run on the platform key or bring your own OpenAI, Anthropic or Gemini key and pick the model. Keys are stored encrypted, per account.',
  },
  {
    icon: 'chart',
    title: 'Progress you can prove',
    body: 'Weekly charts track what was scraped, matched, tailored and applied, with Google Sheets export and Pumble alerts when you want the numbers elsewhere.',
  },
];

export const AUTOFILL_POINTS = [
  {
    title: 'Dedicated engine per platform',
    body: 'Each ATS renders its form its own way, so each one gets a purpose-built engine instead of a single fragile script. Workday is filled deterministically from your structured profile.',
  },
  {
    title: 'Screening questions answered',
    body: 'Years of experience, work authorisation, notice period, salary expectation, EEO and “anything else we should know” are answered from your real profile data.',
  },
  {
    title: 'Documents attached for you',
    body: 'The résumé and cover letter built for that exact job are uploaded with the application, in the right order for parsers that overwrite fields.',
  },
  {
    title: 'Custom career pages included',
    body: 'No known ATS? The generic engine finds the richest application form on the page and fills it best-effort, so unusual sites are still covered.',
  },
];

export const INTEGRATIONS = [
  {
    name: 'Google Sheets',
    body: 'Mirror your job pipeline into a spreadsheet your team already lives in.',
    icon: '/integrations/google-sheets.svg',
  },
  {
    name: 'Pumble',
    body: 'Push new matches and applied jobs into your chat channel automatically.',
    icon: '/integrations/pumble.svg',
  },
];

export const FAQS = [
  {
    q: 'Does it apply to jobs behind my back?',
    a: 'No. Sourcing, scoring and document writing run on their own, but the application itself happens in your browser with you watching. The side panel fills the form and attaches your files; you review the page before it is submitted.',
  },
  {
    q: 'Where do the jobs come from?',
    a: 'Scheduled crawlers cover Adzuna, Jobright, RemoteRocketship, Welcome to the Jungle and ZipRecruiter. You can also paste any job URL, or drop a document full of links, and the same pipeline processes it.',
  },
  {
    q: 'Will my résumé come out looking generic?',
    a: 'It comes out looking like your design. You build the template in the visual editor and the tailored content is compiled into it, so wording changes per role while the layout stays yours. Every version is kept in your résumé library.',
  },
  {
    q: 'Which AI models are used?',
    a: 'OpenAI, Anthropic Claude and Gemini are all supported. Use the platform default or add your own key and choose the model per account. If a provider fails mid-run, the client falls back so your queue keeps moving.',
  },
  {
    q: 'Do I need the Chrome extension?',
    a: 'Only for autofill. Everything else, including scoring, résumé building and downloads, works in the web app. Install the extension when you want the one-pass apply flow and the ready-to-apply queue in a side panel.',
  },
  {
    q: 'What happens to my profile data?',
    a: 'Your profile, documents and preferences are used to score and tailor jobs for your own account. Provider API keys are stored encrypted, and low-scoring or excluded jobs are filtered per user rather than shared.',
  },
];
