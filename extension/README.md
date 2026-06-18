# Job Application Assistant - Browser Extension

A Manifest V3 side-panel extension for the Job Scraper backend. It signs in with
your existing account, caches your profile/settings, and runs a job-specific AI
conversation grounded in your profile and each job's structured description to
help you fill out applications.

No build step is required. This is a plain ES-module extension you load directly.

## Prerequisites

1. Run the Job Scraper backend (see the project root `README.md`).
2. Apply the new database migrations (adds the assistant tables):

   ```bash
   alembic upgrade head
   ```

   This creates `assistant_messages` (migration 037) and `application_sessions`
   (migration 038).

## Load the extension

1. Open `chrome://extensions` (Chrome/Edge).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `extension/` folder.
4. Click the extension's toolbar icon to open the side panel.

## Sign in

- **Server URL**: the backend base URL, e.g. `http://localhost:8000` (no `/api/v1`).
- **Email / Password**: your Job Scraper credentials.

On first sign-in the extension requests permission to access the server origin
and caches your profile, settings, and prompts.

## How it works

- **Auth**: logs in via `POST /auth/login`, which now returns a Bearer token. The
  extension stores it in `chrome.storage.session` and sends it as
  `Authorization: Bearer <token>` on every request (the web app keeps using its
  HttpOnly cookie). Tokens expire after 24h, after which you sign in again.
- **Cache + sync**: profile/settings/prompts are cached per user. The extension
  polls `GET /me/data-version`; if your data changed on the server it shows a
  "Sync now" banner.
- **Ready-to-apply queue**: jobs whose tailored resume DOCX is `completed` and
  that you have not applied to yet.
- **Conversation**: `POST /assistant/chat` streams answers (SSE). History is saved
  per job, so reopening a job restores the chat. The job description is treated as
  untrusted data (prompt-injection guarded) and answers are grounded in your
  profile only.
- **Complete & Exit**: marks the job applied and closes the panel.
- **Complete & Next**: marks the job applied, loads the next ready job
  (`GET /assistant/next-job`), and redirects the active tab to its URL.

## Autofill

Open a job and click **Autofill this page**. The extension asks for one-time
permission to read the active tab, then injects a picker into every frame:

- Hover the application form. Each block is highlighted with a validity color:
  green (one field), amber (several fields, custom, or file upload), red (no
  input or shadow DOM). Click to select; press **Esc** to stop picking.
- Selected blocks appear in the side panel with a badge and a remove button.
- Click **Autofill N fields**. The extension reads each block's controls (type,
  label, options, constraints) - opening custom dropdowns to capture their real
  options - and sends those structured specs plus your profile and the job
  description to `POST /assistant/autofill`. The model returns a value per
  control, and the writer fills each one with framework-safe events: text /
  number / date / email / tel, native `select`, radio/checkbox, contenteditable,
  and custom comboboxes (react-select style). One selection can hold several
  fields (for example Country + Phone); each is mapped by control id.
- File fields (Resume/CV, Cover Letter) are attached automatically: the tailored
  PDF for this job is fetched from the backend and set on the file input. Cover
  letters that are plain text boxes are filled as text instead.

Safety: the extension never submits the form, only attaches your own tailored
resume/cover letter, and routes salary, EEO/demographic, and work-authorization
(when your profile does not state it) plus anything unanswerable to a **Review
these manually** list rather than guessing. Shadow-DOM-enclosed controls are
reported as unsupported.

## CORS (production)

In `local`/`debug` mode the backend already allows `chrome-extension://` origins.
For a production/deployed backend, add your extension origin to the
`CORS_EXTRA_ORIGINS` environment variable (comma-separated), e.g.:

```
CORS_EXTRA_ORIGINS=chrome-extension://<your-extension-id>
```

The extension id is shown on the `chrome://extensions` card after loading.

## Files

- `manifest.json`: MV3 manifest (side panel, background worker, permissions).
- `background.js`: opens the side panel on toolbar click.
- `sidepanel.html` / `styles.css`: UI shell.
- `src/store.js`: `chrome.storage` wrappers (token, backend URL, per-user cache).
- `src/api.js`: Bearer API client + SSE chat streaming.
- `src/app.js`: views and app logic.
