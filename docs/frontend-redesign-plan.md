# NAO Frontend Redesign — Upgrade Plan

Status: proposal · Owner: Raoyinc · Baseline commit: `ee472d8` · Date: 2026-10-03

This plan covers four workstreams: (1) a principal-level UI/UX review and target
design, (2) a component-library decision and component redesign, (3) a clean split
of applicant and admin products, and (4) performance work that uses the full
capacity of the dev machine (22-thread CPU, 16 GB RAM, RTX 4050 6 GB) and the
WSL stack. It ends with a phased roadmap, acceptance criteria, and risks.

---

## 0. Baseline (measured, not estimated)

| Metric | Today | Source |
|---|---|---|
| Frontend source | 207 files, ~47,400 lines TS/TSX | `frontend/src` |
| Largest files | `ScraperJobsTable.tsx` 2,450 · `ResumePreview.tsx` 1,540 · `SystemSettingsPage.tsx` 1,516 · `ScraperStatsBar.tsx` 1,505 · `style.css` 1,456 · `ProfileForm.tsx` 1,426 · `MyPreferencesPage.tsx` 1,355 · `scraperStore.ts` 1,355 | line count |
| Main JS chunk | **1,086 KB** (310 KB gzip) | `vite build` |
| Global CSS | **321 KB** (41 KB gzip) | `vite build` |
| Charts chunk (recharts) | 370 KB (108 KB gzip) | `vite build` |
| Public assets | 2.97 MB, of which Carlito TTF fonts 2.7 MB, `nao-logo.png` 255 KB | `frontend/public` |
| Hardcoded colours | 544 hex literals, 2,028 `slate-*`, 1,143 `dark:`, ~1,048 arbitrary `[...]` values | grep |
| Design-token adoption | `ui/tokens.ts` imported by 24 of ~120 TSX files | grep |
| Component library | none in use (`@headlessui/react` and `@heroicons/react` installed, **0 imports**) | grep |
| Custom animations | 83 `@keyframes`, many infinite | `style.css` |
| Virtualized lists | 0 | grep |
| Tests | 0 test files (Vitest configured) | glob |
| Layout floor | `min-w-[1400px]` shell, `min-w-[1100px]` main (`AppShell.tsx:55,98`) | code |

These numbers are the yardstick for every phase below.

---

## 1. UX review (principal designer perspective)

### 1.1 The product in one sentence
An applicant gives NAO a profile and preferences; NAO finds and scores jobs,
tailors a resume and cover letter per job, and helps them apply. Admins run the
pipeline (sources, sync, models, keys, users, logs).

The UI today does not tell that story. It exposes the pipeline's internals
(boards, extraction states, sync, re-run) to applicants, and it gives admins an
applicant-shaped dashboard with switches turned off.

### 1.2 Findings, ranked by user impact

| # | Severity | Finding | Evidence |
|---|---|---|---|
| U1 | Critical | **No onboarding.** After signup users land on `/scraper` with an empty profile; nothing routes them to Profile → Preferences → first jobs. Match quality depends entirely on the profile. | `App.tsx:257,408`; profile completion only on `ProfilesManagementPage.tsx:125-177` |
| U2 | Critical | **Jobs table overload.** ~16 columns for applicants; each row carries status squares (Applied/Sheets/Pumble), Apply, Run/Re-run, Delete, a context menu, and a bulk bar. No clear primary action per row. | `ScraperJobsTable.tsx:121-142, 907-978, 1078+, 2111-2138, 2430-2526` |
| U3 | High | **Desktop-only.** Hard 1400 px floor; the mobile drawer exists but the content can't fit. | `AppShell.tsx:55,98` |
| U4 | High | **One page, two products.** `/scraper` branches on `isAdmin` in ~40 places across page, table, stats bar, store, analysis modal. | `ScraperDashboard.tsx`, `ScraperJobsTable.tsx`, `scraperStore.ts:215,722-759` |
| U5 | High | **Job detail is a 70vw modal** with its own poll; users lose list context, no deep link per job, no focus trap. | `JobAnalysisModal.tsx:61-71`, `DetailContentPanel.tsx:481-597` |
| U6 | High | **Long expert pages without structure.** Preferences (1,355 lines), Profile (1,426), System Settings (1,516) are single scrolls with no section nav; System Settings auto-saves production knobs on blur. | `MyPreferencesPage.tsx:826+`, `SystemSettingsPage.tsx:714-728,762-1504` |
| U7 | High | **Destructive actions without confirmation**: delete LLM key, interrupt stale scrapes, stop job fetch. | `SystemSettingsPage.tsx:1004-1011,1393-1401`; `JobSyncSettingsSection.tsx:443-449` |
| U8 | Medium | **Two AI surfaces** (sidebar Agent chat, Resume Builder One-Click AI) with different look and unclear division of labour. | `AgentChat.tsx`, `OneClickAICenter.tsx` |
| U9 | Medium | **Duplicate metrics homes**: Jobs "focus stats" and Job Analysis "intake pulse" show overlapping numbers. | `JobsFocusStats`, `JobAnalysisPage.tsx:178-220` |
| U10 | Medium | **Inconsistent feedback**: global toasts, per-section inline messages, silent failures in paste-URL modal. | `NotificationToasts`, `MyPreferencesPage` `SectionMessage`, `SubmitForm.tsx:85-97` |
| U11 | Medium | **Pattern drift**: 4 select implementations, 4 toggle implementations, ~12 hand-rolled modals, 2 context menus. | `MenuSelect`, `DashboardViewSwitcher`, `MatchScoreFilter`, `LlmProviderSelector`, … |
| U12 | Medium | **Accessibility gaps**: no focus traps in modals, mouse-centric context menu, icon-only status cells relying on `title`, colour-only pipeline states. | multiple |
| U13 | Low | **Orphan/duplicate routes**: `/billing` hidden from nav; `/data-analysis` and `/data-management` render the same page; empty-state copy mentions "Sync All" to applicants. | `Sidebar.tsx:84-86`, `App.tsx:369-382`, `ScraperJobsTable.tsx:2097` |
| U14 | Low | **Two visual systems**: cinematic hex-coded landing vs sky/slate app; violet AI chat vs sky brand. | `LandingPage.tsx:42`, `AgentChat.tsx:298` |

### 1.3 Design principles for the new UI
1. **One primary action per surface.** Every page and every row answers "what should I do next?" with exactly one emphasized action.
2. **Show outcomes, hide machinery.** Applicants see *Match*, *Ready to apply*, *Applied*. Extraction, encoding, boards, and sync are admin vocabulary.
3. **Progressive disclosure.** Defaults first, advanced behind "Advanced" sections, expert prompts behind an explicit toggle.
4. **List-detail, not modal.** Job detail opens in a right-side panel with its own URL (`/app/jobs/:id`) while the list stays visible.
5. **Realtime without noise.** Live updates patch rows in place; no full-table refetch, no layout jump.
6. **Keyboard first-class.** `⌘K` command palette, `j/k` row navigation, `Enter` open, `A` mark applied, `Esc` close.
7. **Responsive by design.** 360 px mobile to 1920 px desktop; tables collapse to cards below `md`.
8. **WCAG 2.2 AA** as a release gate.

---

## 2. Target information architecture and UX design

### 2.1 Personas
- **Applicant**: job seeker, possibly non-technical, checks daily, wants a short list of good matches and fast tailored documents.
- **Admin / operator**: you; runs sources, sync, models, keys, cost, and support. Needs density, filters, bulk ops, and audit.

### 2.2 Route tree

```
/                      Landing (public)
/login /signup         Auth (public)
/onboarding            First-run wizard (applicant, until complete)

/app                   ApplicantShell
  /app                 → Home (today: what's new, ready to apply, next steps)
  /app/jobs            Jobs list (saved views: Recommended · Ready to apply · Applied · All)
  /app/jobs/:jobId     Job detail panel (match breakdown, JD, documents, apply)
  /app/documents       Resume builder + library (was /resume-builder)
  /app/insights        Personal analytics (was /job-analysis)
  /app/profile         Profile (sectioned, with completeness)
  /app/settings        Preferences · Matching · AI & keys · Notifications
  /app/integrations    Job sites · Google Sheets · Pumble
  /app/billing         (feature-flagged, BILLING_ENABLED)

/admin                 AdminShell (is_admin required)
  /admin               → Overview (pipeline health, queue depth, failures, cost)
  /admin/pipeline      Jobs board for operators (fetch/extract/encode/analyze states)
  /admin/pipeline/:id  Extraction detail (raw JD, extraction log, re-extract)
  /admin/sources       Sync schedule, spiders, job sources, blocked domains
  /admin/ai            LLM defaults, provider key pool, bindings, benchmark, match engine
  /admin/workers       Worker concurrency, queues, stale runs
  /admin/users         Users table + user detail drawer
  /admin/data          Analytics + cleanup (tabs)
  /admin/logs          System logs (also the logs.* host root)
```

Legacy redirects: `/scraper` → `/app/jobs` or `/admin/pipeline` by role;
`/profile`, `/preferences`, `/settings`, `/resume-builder`, `/job-analysis`,
`/integrations`, `/billing`, `/data-analysis`, `/data-management`,
`/user-management`, `/system-settings`, `/system-logs` → new paths. Keep for one
release, then remove.

Role guard: `/app/*` requires authenticated non-admin **or** an admin in
"view as applicant" mode (useful for support); `/admin/*` requires `is_admin`.
Server-side `require_admin` stays the source of truth.

### 2.3 Applicant journey (target)

```
Signup → Onboarding (4 steps, skippable, resumable)
  1. Import resume (drag-drop PDF/DOCX)  → auto-fills profile
  2. Confirm profile essentials (title, years, skills, location)
  3. Preferences (roles, remote/hybrid, countries, salary floor, min match)
  4. Connect a source or paste job URLs  → first jobs start processing
→ Home: "3 new strong matches · 2 ready to apply · Profile 80%"
→ Jobs (Recommended view) → open job (side panel)
→ Match breakdown → Generate tailored resume/cover letter → Review → Apply (extension)
→ Mark applied (auto when extension reports submit) → Applied view
```

### 2.4 Page specifications

**Home (`/app`)**
- Header greeting + one CTA that changes with state: *Finish profile* → *Add jobs* → *Review N matches*.
- Cards: New matches (count + top 3), Ready to apply, In progress (live), Applied this week.
- Onboarding checklist card until 100%.

**Jobs (`/app/jobs`)**
- Toolbar: saved-view tabs · search (title/company) · filter chips (Remote, Country, Min match, Posted within) · "Add jobs" button (paste URLs / connect site) · density toggle.
- Table, 7 columns max: Match (score ring + label) · Role & company · Location/mode · Posted · Documents (resume/cover status) · Status (New / Preparing / Ready / Applied) · one row action (*Prepare* / *Apply* / *Open*).
- Secondary actions (Re-run, Hide, Send to Sheets/Pumble, Mark applied) in a row kebab menu **and** in the detail panel. Bulk bar appears only on selection.
- Below `md`: card list with score, title, company, status, one action.
- Virtualized rows; infinite scroll with server cursor; sticky header.
- Live updates: a row's status pill animates from *Preparing* to *Ready* in place.

**Job detail (`/app/jobs/:jobId`, side panel 480–720 px, full screen on mobile)**
- Header: title, company, score ring, primary action.
- Tabs: *Match* (score breakdown by skills / experience / location / seniority, matched vs missing skills, explanation) · *Description* · *Documents* (resume, cover letter, versions, regenerate with instruction) · *Activity*.
- Deep-linkable; `j/k` moves to next/previous job without closing.

**Documents (`/app/documents`)**
- Left: library (versions, base resume, per-job variants). Centre: editor with tabs *Content* · *Design*. Right: live preview.
- Design tab groups: Theme → Typography → Colour → Layout → Sections (accordion, one open at a time).
- Preview compiles off the main thread (Web Worker) with debounce on *commit* (slider release), not on every tick.
- One AI entry point: the shared Assistant panel in "document" context (replaces the separate One-Click chat UI; keep its tailoring backend).

**Profile (`/app/profile`)**
- Section nav (sticky, left): Basics · Summary · Experience · Education · Skills · Certifications · Links · Source documents.
- Each section is a card with view mode and edit mode; edit uses a form with inline validation; autosave draft locally, explicit Save.
- Completeness meter in the header with "next best field" suggestions.

**Settings (`/app/settings`)** — tabs: *Job preferences* · *Matching* (min score, dedup, auto-prepare) · *AI & keys* (provider, model, BYO keys) · *Prompts (advanced)* · *Notifications*. Each tab has one Save bar that appears when dirty.

**Integrations (`/app/integrations`)** — grid of connection cards with status (Connected / Needs attention / Off), each opening a sheet (side drawer) with setup and filters.

**Assistant** — one global panel (right side, `⌘J`), context-aware (current page / selected job / document), with suggestions driven by state ("Your profile is missing skills; want me to extract them from your resume?"). Actions that mutate data show a confirm card (already supported by backend flow).

**Admin Overview (`/admin`)** — tiles: Jobs ingested today, Extraction success %, Queue depth per worker, Match latency p50/p95, LLM spend today, Errors last hour; each tile links to its page. Live via WS.

**Admin Pipeline (`/admin/pipeline`)** — dense table (compact density default) with column chooser, server-side sort/filter, state filter chips (Queued, Extracting, Failed, Encoded, Analyzed), bulk *Re-extract* / *Delete*, extraction detail drawer with raw text and log.

**Admin AI (`/admin/ai`)** — tabs: Defaults · Provider keys (masked, test, rotate, delete with confirm) · Bindings · Match engine · Benchmark. **Explicit Save** with diff preview for production knobs; no auto-save.

**Admin Users** — server-paginated, sortable table; row opens user drawer (profile summary, usage, role, enable/disable, reset, impersonate-as-view). Every destructive action uses typed confirmation for bulk.

**Admin Logs** — saved filter presets as chips at top, live tail toggle, virtualized table, detail drawer. Filters apply immediately (debounced), no "Apply" button.

### 2.5 Interaction patterns (one implementation each)

| Pattern | Rule |
|---|---|
| Dialog | Only for short, blocking decisions (confirm, rename). Focus-trapped, `Esc` closes. |
| Sheet / drawer | Detail and edit flows that keep context (job detail, user detail, integration setup). |
| Toast (Sonner) | Async results; errors stay until dismissed and include a *Retry* action. Inline messages only for field validation. |
| Confirm | `ConfirmDialog` for single destructive actions; typed confirmation for bulk deletes and key rotation. |
| Empty state | Illustration-free: icon, one sentence, one CTA. Every list has one. |
| Loading | Skeletons matching final layout; never a full-screen loader after first paint. |
| Errors | Route-level error boundary with retry; query errors render inline with retry. |
| Forms | Labels always visible, helper text, inline errors on blur, dirty-state save bar, `Ctrl+S` saves. |
| Tables | Sticky header, sortable columns, column visibility, density toggle, keyboard row nav, selection with `Shift`-range. |

### 2.6 Responsive breakpoints
`sm 640` cards · `md 768` compact table · `lg 1024` sidebar collapsible to icons · `xl 1280` list + detail side by side · `2xl 1536` three panes in Documents.

---

## 3. Component library decision

### 3.1 Candidates (state as of October 2026)

| Library | Styling engine | Fit with current Tailwind 4 code | Bundle / runtime | Tables & forms | Verdict |
|---|---|---|---|---|---|
| **shadcn/ui on Base UI** (CLI v4, Base UI 1.6, default since July 2026) | Tailwind v4, zero runtime, you own the source | Native — same utilities, OKLCH CSS variables, `@theme` | Smallest; only what you add | Pairs with TanStack Table/Virtual, react-hook-form + zod (official patterns) | **Choose** |
| Mantine v8 | CSS Modules, zero runtime | Second styling system beside Tailwind | Moderate | Strong built-ins (dates, forms, notifications) | Runner-up |
| MUI v7 (+ MUI X) | Emotion runtime CSS-in-JS; Pigment CSS paused (June 2026) | Conflicts with Tailwind; override-heavy | Heavier, runtime style injection | Best data grid (Pro/Premium are paid) | Reject |
| Ant Design v6 | CSS variables, optional zero-runtime mode | Strong visual identity, hard to make look like NAO | Largest of the set | Excellent admin tables/forms | Reject for app; acceptable only if admin were a separate app |
| Chakra v3 / HeroUI | Panda / Tailwind + runtime parts | Partial | Moderate–heavy | Average | Reject |

### 3.2 Why shadcn/ui on Base UI
- The codebase is already Tailwind 4; the migration replaces class soup with owned components instead of adding a second styling engine.
- Zero runtime styling cost and per-component tree shaking address the bundle problem directly.
- Accessible primitives (focus trap, roving focus, typeahead, ARIA) fix U11/U12 by construction.
- Source lives in `src/components/ui/*`, so NAO-specific variants (score ring, pipeline pill, density) are first-class, not overrides.
- Base UI is the default for new shadcn projects and is actively maintained by the Radix/Floating UI/MUI authors; no migration debt from Radix.

### 3.3 Final frontend stack

| Concern | Choice | Replaces |
|---|---|---|
| Primitives + components | shadcn/ui (Base UI) in `src/components/ui` | hand-rolled modals, selects, toggles, menus; Headless UI (unused) |
| Icons | `lucide-react` only | remove `@heroicons/react` |
| Styling | Tailwind 4 + semantic CSS variables (OKLCH) via `@theme inline` | 1,456-line `style.css` with slate remap; `ui/tokens.ts` |
| Class merging | `clsx` + `tailwind-merge` (`cn()`) and `class-variance-authority` for variants | string concatenation |
| Server state | **TanStack Query v5** | ad-hoc fetching in zustand stores, `requestOnce`, sessionStorage caches, polling |
| Tables | **TanStack Table v8** + **TanStack Virtual v3** | `ScraperJobsTable` monolith, unvirtualized logs/users tables |
| Forms | **react-hook-form** + **zod** (schemas shared with API types) | local `useState` forms, manual validation |
| API types | **openapi-typescript** generated from FastAPI `/openapi.json` + a typed fetch client | hand-written `types/*.ts` drifting from backend |
| Client UI state | zustand (UI only: panels, density, theme, selection) with `useShallow` selectors | zustand as data cache |
| Toasts | `sonner` (shadcn standard) | `NotificationToasts` + `uiStore.notify` |
| Command palette | `cmdk` (shadcn Command) | none |
| Charts | Recharts via shadcn Chart wrappers, **lazy-loaded only** | same lib, currently in a 370 KB chunk loaded by multiple pages |
| Dates | `date-fns` + shadcn Calendar | `FlexibleDatePicker` |
| Markdown | `react-markdown` lazy-loaded in prompt editors / assistant only | eager import via Preferences |
| Animation | CSS transitions + `tw-animate-css`; Motion only on Landing (lazy) | 83 keyframes |
| Compiler | **React Compiler 1.0** (`babel-plugin-react-compiler`) | manual `useMemo`/`memo` (only 3 `memo` today) |
| Testing | Vitest + Testing Library + MSW; Playwright e2e + axe | none |
| Quality | ESLint flat config (react-hooks, jsx-a11y, tailwind), `rollup-plugin-visualizer`, Lighthouse CI | none |

---

## 4. Design system

### 4.1 Tokens (single source in `src/styles/theme.css`)
- **Colour (semantic, OKLCH)**: `--background`, `--foreground`, `--card`, `--popover`, `--primary` (NAO sky→indigo), `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, plus product semantics: `--match-strong`, `--match-good`, `--match-weak`, `--status-preparing`, `--status-ready`, `--status-applied`, `--status-failed`, `--chart-1..5`.
- Dark mode: the same variables redefined under `.dark`. Delete the `.dark { --color-slate-* }` remap and the ~168 override rules.
- **Typography**: Inter Variable (self-hosted WOFF2, ~100 KB) for UI; tabular numbers for scores and counts. Scale: 12 / 13 / 14 (base) / 16 / 18 / 20 / 24 / 30.
- **Spacing and radius**: 4 px grid; radius `--radius: 0.625rem` with sm/md/lg/xl derived.
- **Density**: `comfortable` (applicant default) and `compact` (admin default) via a `data-density` attribute that changes row height and padding tokens.
- **Elevation**: 3 levels (card, popover, dialog); no coloured shadows.
- **Motion budget**: 150–200 ms ease-out for UI; no infinite animations except an active-progress indicator; respect `prefers-reduced-motion`.
- **Z-index scale**: base, sticky, dropdown, sheet, dialog, toast, tooltip — defined once.

### 4.2 Component inventory (old → new)

| New component (`components/ui` or `components/app`) | Replaces |
|---|---|
| `Button`, `IconButton` (variants: primary, secondary, ghost, destructive, link) | `btnPrimary/Secondary/Ghost/Danger/Save*`, `prefsSaveBtnClass`, ad-hoc gradients |
| `Dialog`, `AlertDialog`, `Sheet` | `JobActionModal`, `ConfirmDialog`, `JobAnalysisModal`, `DuplicatesModal`, `DocumentPreviewModal`, `InstallExtensionModal`, `PumbleDestinationModal`, paste modal, checkout overlay, import conflict modal |
| `Select`, `Combobox`, `MultiSelect` | `MenuSelect`, `DashboardViewSwitcher`, `MatchScoreFilter`, `LlmProviderSelector`, data-management dropdowns |
| `Switch`, `ToggleGroup`, `Tabs` | `SettingsToggle`, `ThemeToggle`, `RemoteFilterToggle`, `ModeToggle`, inline tab button groups |
| `DropdownMenu`, `ContextMenu` | two portal context menus |
| `DataTable` (TanStack + Virtual) with `ColumnHeader`, `ColumnToggle`, `BulkBar`, `Pagination` | `ScraperJobsTable`, users table, logs table, scrape-runs table, cleanup preview |
| `Form`, `Field`, `Input`, `Textarea`, `NumberInput`, `DatePicker` | per-page inputs, `FlexibleDatePicker` |
| `Card`, `StatCard`, `SectionCard` | `SettingsCard`, `IntegrationCard`, `StatCard`, 36× `rounded-2xl border border-slate-200` |
| `Badge`, `StatusPill`, `ScoreRing`, `MatchBreakdown` | `Badge`, ad-hoc chips, match badges, colour-only pipeline squares |
| `EmptyState`, `Skeleton`, `ErrorState` | per-page empty/loader variants, full-screen `BrandedLoader` after first paint |
| `Toaster` (sonner) | `NotificationToasts` |
| `CommandPalette` | — |
| `PageHeader`, `PageSection`, `SectionNav` | `PageHeader`, `PageScrollArea` |
| `Chart*` (lazy) | `DualLineChart`, `MultiLineChart`, `TrendSparkline` |

### 4.3 Design deliverables before code
1. Token sheet and component states (light/dark, comfortable/compact) — build as a `/__design` route in dev (cheaper than Storybook; can add Storybook later).
2. Wireframes for Home, Jobs + detail panel, Onboarding, Documents, Admin Overview, Admin Pipeline.
3. Copy deck: applicant vocabulary (*Preparing*, *Ready to apply*) vs admin vocabulary (*Extracting*, *Encoded*, *Analyzed*).

---

## 5. Architecture

### 5.1 Folder structure (feature-sliced)

```
frontend/src/
  app/                 router.tsx, providers.tsx (QueryClient, Theme, Toaster), guards.tsx
  shells/              ApplicantShell/, AdminShell/, PublicShell/
  components/ui/       shadcn components (owned)
  components/app/      NAO composites: ScoreRing, StatusPill, DataTable, EmptyState, ...
  features/
    auth/ onboarding/ home/ jobs/ job-detail/ documents/ profile/ settings/
    integrations/ assistant/ insights/ billing/
  admin/
    overview/ pipeline/ sources/ ai/ workers/ users/ data/ logs/
  api/                 generated/schema.d.ts, client.ts, queryKeys.ts, realtime.ts
  lib/                 cn.ts, format.ts, hotkeys.ts, featureFlags.ts
  styles/              theme.css, fonts.css
  test/                msw handlers, fixtures, setup
```

Rule: `features/*` never imports from `admin/*` and vice versa; shared code goes
to `components/app` or `api`. Enforce with ESLint `no-restricted-imports`.

### 5.2 Routing and code splitting
- `createBrowserRouter` with route objects and `lazy` per route; `ApplicantShell` and `AdminShell` are separate lazy chunks, so applicants never download admin code and vice versa (today the shared Jobs tree ships admin branches to everyone).
- Route `loader`s prefetch the first query (`queryClient.ensureQueryData`) to remove waterfalls.
- Prefetch the next likely route on hover/idle (Jobs → Job detail chunk).

### 5.3 Data layer
- **TanStack Query** owns all server data. Query key factory (`api/queryKeys.ts`): `jobs.list(filters)`, `jobs.detail(id)`, `jobs.analysis(id)`, `stats.applicant()`, `admin.stats()`, `profile()`, `settings()`, …
- Defaults: `staleTime` 30 s for lists, 5 min for profile/settings, `refetchOnWindowFocus` on for lists only, `placeholderData: keepPreviousData` for paging/filters.
- Mutations use optimistic updates for mark-applied, hide, re-run, with rollback on error.
- Remove: `scraperStore` data fields, `jobsStore` lists, `requestOnce`, sessionStorage stats caches, the 6 s / 10 s / 15 s / 4 s polls.

### 5.4 Realtime (fixes the refetch storm)
Today every one of 14 pipeline WS events triggers `bgRefreshJobs` + `loadStats`
(`App.tsx:101-177`), and `debouncedRefresh` exists but is unused.

New `api/realtime.ts`:
1. One WS connection (existing endpoint) → event bus.
2. Events with a job id **patch** `jobs.detail(id)` and the matching row in any cached `jobs.list` via `queryClient.setQueriesData` (status, score, document flags).
3. Aggregate counters are invalidated **at most once per 2 s** (coalesced), never per event.
4. Sync events update a small `sync` query; admin-only events are handled only inside `AdminShell`.
5. Fallback: if WS is disconnected > 10 s, enable `refetchInterval: 15000` on active lists only; disable on reconnect.

Backend support (small, recommended): include the changed fields in pipeline
events (`{type, job_id, status, match_score, resume_ready, cover_ready}`), so the
client can patch without a refetch.

### 5.5 API typing
- Generate `api/generated/schema.d.ts` with `openapi-typescript` from `http://127.0.0.1:8000/openapi.json` (`npm run api:gen`); use `openapi-fetch` (2 KB) for typed calls. Axios can be removed.
- CI check: regenerate and fail on diff, so frontend types never drift from FastAPI models.

### 5.6 State rules
- Server data: TanStack Query only.
- URL state: filters, sort, view, selected job id (shareable, back button works).
- UI state: zustand (sidebar collapsed, density, assistant open, table selection) with `useShallow`; never whole-store subscriptions (today: `ScraperDashboard.tsx:43`, `ResumeBuilderPage.tsx:47`, `AgentChat.tsx:211`).
- Form state: react-hook-form.

---

## 6. Performance plan

### 6.1 Budgets (CI-enforced)

| Metric | Today | Target |
|---|---|---|
| Applicant initial JS (shell + Jobs route) | 310 KB gzip (one chunk) | **≤ 160 KB gzip** |
| Admin initial JS (shell + Overview) | same 310 KB + page chunk | ≤ 200 KB gzip |
| Landing initial JS | in the 310 KB chunk | ≤ 90 KB gzip |
| CSS | 41 KB gzip / 321 KB raw | ≤ 20 KB gzip |
| Fonts on app routes | Carlito 2.7 MB TTF declared globally | Inter WOFF2 ≤ 100 KB; Carlito WOFF2 only in Documents |
| LCP (Jobs, warm cache, local) | not measured | ≤ 1.5 s |
| INP (row action, filter change) | not measured | ≤ 100 ms |
| Jobs list with 1,000 rows scrolling | not virtualized | 60 fps, < 40 DOM rows |
| Requests per pipeline event burst (50 events) | ~100 refetches | ≤ 2 refetches + local patches |

### 6.2 Actions
1. **Split by shell and route** (5.2). Lazy-load Landing, Stripe (Billing only), react-markdown, Recharts, Resume preview, Assistant panel.
2. **`build.rollupOptions.output.manualChunks`**: `react`, `router+query`, `ui` (Base UI + shadcn), `charts`, `stripe`, `markdown`. Long-term cacheable vendor chunks.
3. **Virtualize** every list over 50 rows (jobs, logs, users, invalid/duplicate panels; `JOB_PAGE_SIZE=300` becomes cursor pages of 50 with virtual scroll).
4. **React Compiler** on the whole app; delete manual memo once green.
5. **Kill the polling layers**, use realtime patches (5.4).
6. **CSS diet**: delete slate remap + overrides, cut keyframes from 83 to ≤ 10, no infinite animations on the Jobs page.
7. **Assets**: logo to SVG (or 2× WebP ≤ 20 KB); Carlito TTF → WOFF2 subset (~70% smaller) loaded via `FontFace` only in Documents; self-host landing media as AVIF/WebM with poster images and `loading="lazy"`; stop hotlinking remote video.
8. **Resume preview in a Web Worker**: move PDF compile/render off the main thread; debounce on commit.
9. **Measure**: `rollup-plugin-visualizer` report per build, `web-vitals` reporter to the existing logs endpoint (admin can see real INP/LCP), Lighthouse CI on Landing, Jobs, Documents.

---

## 7. Using this machine's full capacity

### 7.1 Developer loop (22 threads, 16 GB RAM, WSL2)
- **Repo on ext4 (`~/NAO`)** — already done; keep Cursor attached via *Connect to WSL* so file watching is native (on `/mnt/d` it is several times slower).
- **Vite 8 (Rolldown bundler)**: production builds take 43 s today on Vite 7; Rolldown typically cuts that by 3–10×. Verify the plugin set (React, compiler) at upgrade time.
- **Type checking**: `tsc --noEmit` in watch in a separate supervisor program, or try the native TypeScript compiler preview (`tsgo`) for ~10× faster checks; keep `tsc` as the CI gate.
- **Vitest** with `pool: 'threads'` and `maxThreads: 12`; **Playwright** with 6 workers headless Chromium (already installed in WSL).
- **`.wslconfig`**: memory=10GB is right for the full stack; during heavy builds stop `scraper`/`autopost` (`wsl-stack.sh stop scraper`) rather than raising memory.
- Add a `frontend:check` supervisor program (type-check + lint watch) so errors show in `.run/logs` while you work.

### 7.2 Backend changes that make the UI feel instant
| Change | Effect on UI |
|---|---|
| Pipeline WS events carry changed fields | In-place row updates, no refetch (5.4) |
| Cursor pagination + server-side sort/filter on `/jobs/dashboard` and admin lists | Virtual infinite scroll; constant-time pages |
| Lean list DTO (no JD body, no analysis blob in list rows) | Smaller payloads; detail fetched on open |
| `ETag` / `If-None-Match` on profile, settings, stats | 304s on refocus |
| Redis-cached stats (5–10 s TTL, invalidated by pipeline events) | Stats tiles cost ~1 ms instead of aggregate queries |
| Brotli/gzip for JSON (`GZipMiddleware` or nginx) | 70–85% smaller list responses |
| `/openapi.json` stable operation ids | Clean generated client names |

### 7.3 GPU (RTX 4050, 6 GB) — currently using ~100 MB for MiniLM
| Opportunity | Value | Cost |
|---|---|---|
| **Upgrade embeddings** to `all-mpnet-base-v2` or `bge-base-en-v1.5` (768-dim) | Better match quality; GPU makes it cheap (~420 MB VRAM, batch 64) | Re-encode backfill (minutes on GPU); migration for vector dim |
| **Cross-encoder re-ranking** (`ms-marco-MiniLM-L-6-v2` or `bge-reranker-base`) on the top 50 matches per user | Sharper "Recommended" ordering, better UX trust | ~300 MB VRAM; runs in the encoding worker |
| **Instant semantic search** endpoint (query → embedding → cosine over job vectors) | Search box understands "backend python remote" not just substrings | One endpoint + pgvector/numpy; ~5 ms per query on GPU |
| **Skill extraction / explanation** from embeddings for the Match tab | Richer "matched vs missing skills" without LLM calls | CPU/GPU light |
| Optional: small local LLM (≈3–4B, 4-bit) for cheap tasks (title normalization, short summaries) | Lower OpenAI cost and latency | Competes for 6 GB VRAM with Chromium GPU and embeddings; only after measuring headroom |

Keep tailoring on the cloud LLM: quality matters and the GPU can't host a model
of that class.

### 7.4 CPU / extraction
- After the frontend no longer polls, raise `EXTRACTION_WORKER_MAX_JOBS`/`BROWSER_POOL_SIZE` from 3 to 4–5 if `btop` shows headroom (each Chromium ~300–500 MB).
- Start `analysis2` during bulk auto-prepare runs.

---

## 8. Phased roadmap

Estimates assume one developer working with an AI pair, ~6 productive hours/day.
Each phase ends deployable; old and new UIs coexist behind redirects until Phase 7.

### Phase 0 — Foundation (4–5 days)
- Add tooling: ESLint flat config, Prettier, `rollup-plugin-visualizer`, Vitest + MSW, Playwright + axe, Lighthouse CI script.
- `npx shadcn init` (Base UI, Tailwind 4, `src/components/ui`), `cn()`, `theme.css` with NAO tokens (light/dark, density).
- Add TanStack Query, Table, Virtual, react-hook-form, zod, sonner, cmdk, openapi-typescript + openapi-fetch; React Compiler.
- `npm run api:gen` from FastAPI; typed client.
- Record baseline report (bundle, Lighthouse) in `docs/perf/baseline.md`.
- `/__design` route with all primitives in both themes and densities.
- **Exit**: build green, design route reviewed, baseline captured.

### Phase 1 — Shells, routing, role split (4 days)
- `createBrowserRouter`, `PublicShell`, `ApplicantShell`, `AdminShell` (separate lazy chunks), guards, legacy redirects, `logs.*` host → `/admin/logs`.
- New sidebars (collapsible, icon rail at `lg`), top bar with `⌘K` palette, user menu, theme switch.
- Mount existing pages inside new shells unchanged (strangler step).
- Remove `min-w-[1400px]` floor; pages scroll horizontally only where unavoidable until rebuilt.
- **Exit**: applicants' initial bundle contains no admin code (verified in visualizer); all old URLs redirect.

### Phase 2 — Data and realtime layer (4–5 days)
- QueryClient, key factory, query hooks for jobs/stats/profile/settings; adapters so old components can read from Query.
- `api/realtime.ts` with patching + coalesced invalidation; remove polls one by one.
- Backend: enrich pipeline WS events; lean list DTO; cursor pagination for `/jobs/dashboard`.
- **Exit**: a 50-event burst causes ≤ 2 list refetches; no `setInterval` polling left in Jobs.

### Phase 3 — Applicant Jobs + Job detail (8–10 days)
- `DataTable` (virtualized, sortable, column visibility, keyboard nav, bulk bar) and mobile card list.
- Jobs page with saved views, filter chips (URL-synced), Add-jobs sheet (paste URLs, connect site).
- Job detail side panel with Match / Description / Documents / Activity tabs; deep links; `j/k`.
- Optimistic mark-applied / hide / re-run; status pills; score ring.
- Delete `ScraperDashboard` applicant branches, `ScraperJobsTable` applicant code, `JobAnalysisModal` for applicants.
- **Exit**: usability check of the core loop (find → open → prepare → apply) in ≤ 4 clicks; INP ≤ 100 ms; axe clean.

### Phase 4 — Onboarding, Home, Profile, Settings, Integrations, Insights (8–9 days)
- Onboarding wizard (resume import → essentials → preferences → first jobs), resumable, skippable.
- Home dashboard with state-driven CTA and checklist.
- Profile with section nav, view/edit cards, react-hook-form + zod, completeness meter.
- Settings tabs with dirty-state save bar; Prompts behind *Advanced*.
- Integrations cards + setup sheets.
- Insights page (merge Job Analysis + focus stats; lazy charts).
- **Exit**: new user reaches first scored job without leaving the guided path; all forms keyboard-complete.

### Phase 5 — Documents (Resume Builder) + Assistant (6–7 days)
- Three-pane layout, library, Content/Design tabs with accordions, preview Web Worker, commit-debounced compile.
- Carlito WOFF2 loaded only here.
- Unified Assistant panel (`⌘J`) with page/job/document context; One-Click tailoring becomes an Assistant action in document context.
- **Exit**: no main-thread task > 50 ms while dragging design controls.

### Phase 6 — Admin console (8–9 days)
- Overview tiles (live), Pipeline table + extraction drawer, Sources, AI (explicit save with diff, confirmations), Workers, Users (server-paginated, drawer), Data (tabs), Logs (virtualized, live tail).
- Typed confirmation for destructive bulk ops; audit-friendly toasts.
- Delete `SystemSettingsPage` monolith, admin branches in the old Jobs tree, `ScraperStatsBar`.
- **Exit**: every destructive admin action is confirmed; admin pages load ≤ 200 KB gzip.

### Phase 7 — Landing, auth, hardening, cleanup (4–5 days)
- Landing rebuilt on the token system (keep the cinematic look via a `marketing` theme), self-hosted optimized media, lazy demos.
- Auth screens on shadcn forms; multi-error display.
- Remove legacy redirects after one release, `style.css` remainder, `ui/tokens.ts`, old stores, axios, Headless UI, Heroicons.
- Performance budgets enforced in CI; Lighthouse ≥ 90 on Landing/Jobs; WCAG 2.2 AA audit pass.
- **Exit**: all budgets in 6.1 met; zero legacy imports (ESLint rule).

**Total: ~47–54 working days (≈ 10–11 weeks).** Phases 3, 4 and 6 can overlap if
a second contributor joins (admin and applicant trees are independent after
Phase 2).

### GPU/backend track (parallel, ~6–8 days)
1. Enriched WS events + lean DTO + cursor pagination (with Phase 2).
2. Redis-cached stats + ETags + compression.
3. Embedding upgrade + GPU backfill script (+ A/B in shadow mode, which the match engine already supports).
4. Cross-encoder rerank in the encoding worker for "Recommended".
5. Semantic search endpoint feeding the Jobs search box.

---

## 9. Migration strategy, testing, risks

### 9.1 Strangler migration
- New shells first, old pages mounted inside them; replace page by page.
- A `featureFlags.ts` (read from `/settings` or env) can switch a user between old and new Jobs page during Phase 3 for safe comparison.
- Each phase merges to `main` behind redirects/flags; production deploys stay continuous.

### 9.2 Testing
| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | formatters, query key factory, realtime patch reducer, zod schemas |
| Component | Testing Library + MSW | DataTable, forms, guards, dialogs (focus, Esc) |
| E2E | Playwright (6 workers) | signup → onboarding → first job → prepare → mark applied; admin: user disable, key rotate, logs filter |
| Accessibility | `@axe-core/playwright` | every route, both themes |
| Visual | Playwright screenshots of `/__design` | catch token regressions |
| Performance | visualizer budgets + Lighthouse CI | per PR |

### 9.3 Risks and mitigations
| Risk | Mitigation |
|---|---|
| Big-bang rewrite stalls | Strangler order above; every phase shippable |
| Backend contract drift during refactor | Generated OpenAPI types + CI diff check |
| Realtime patching shows stale aggregates | Coalesced invalidation every 2 s + fallback polling when WS down |
| Admins lose a niche control from the old settings page | Inventory every control in `SystemSettingsPage` before deletion (checklist in the PR) |
| Base UI API differences from Radix examples online | Use shadcn's Base UI docs tab; keep wrappers in `components/ui` so call sites don't change |
| Resume rendering fidelity changes in the worker | Golden-file PDF comparison on 5 reference resumes |
| VRAM contention after GPU features | Measure with `nvtop`; keep `BROWSER_USE_GPU=false`; rerank batch size configurable |

---

## 10. Immediate next steps
1. Review and adjust this plan (scope, route names, order).
2. Phase 0 day 1: tooling + shadcn init + tokens + `/__design` route + baseline report.
3. Backend quick win in parallel: enrich pipeline WS events (unblocks Phase 2).
