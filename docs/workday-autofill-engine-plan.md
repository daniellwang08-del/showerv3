# Workday Autofill Engine - Implementation Plan

Status: proposed (not yet built)
Owner: autofill
Last updated: 2026-06-18

This plan defines a dedicated, platform-specific autofill engine for **Workday**
job applications, plugged into the engine routing layer added for the Greenhouse
engine. It is informed by a deep read of the SpeedyApply extension (a proven
Workday autofiller) and by an end-to-end review of how resume data is stored in
this codebase.

---

## 1. Goal & paradigm

Workday application forms are a multi-step SPA wizard (My Information → My
Experience → Application Questions → Voluntary Disclosures → Self Identify →
Review). Every input carries a **stable `data-automation-id`** attribute, so the
form can be filled **deterministically** by mapping a structured user profile to
known selectors - **no manual field selection and no LLM** for the standard
fields.

This is the OPPOSITE paradigm to the current Greenhouse engine:

| | Greenhouse engine (`mode: "select"`) | Workday engine (`mode: "workday"`) |
|---|---|---|
| Field discovery | user manually selects regions | automatic, by `data-automation-id` |
| Value source | LLM reads DOM-with-options | structured profile, code-mapped |
| LLM usage | yes (per control) | only for free-text questions (later phase) |
| Steps | single page | multi-step wizard, SPA-aware |

The routing layer (`extension/src/engines.js`) already detects Workday URLs
(`*.myworkdayjobs.com`) and reserves `ENGINES.workday` with `mode: "workday"`,
`available: false`. This plan makes it available.

---

## 2. Reference: how SpeedyApply fills Workday

Evidence from `../folder/content-scripts/content.js` (SpeedyApply v2.24.1):

- **URL routing**: `RS = [{script: LS, pattern: /(myworkdayjobs|myworkdaysite)\.com/}, {greenhouse...}, ...]`; picks a platform module by `window.location.href`.
- **Deterministic mapping, no LLM** (`openai`/`gpt`/`chatgpt` = 0 occurrences). `data-automation-id` appears 199×.
- **Primitives**: `k(value, selector)` React-safe text fill; `j(selector)` toggle radio/checkbox; `Hn(value, base)` open custom dropdown + pick listbox option by text; `M(...)` native select with option-wait; `x`/`y` XPath query + wait; `I(ms)` delay.
- **Selector inventory** (stable across tenants):
  - Name: `infoFirstName`, `infoLastName`, `infoPreferredName`
  - Contact: `infoEmail`, `infoCellPhone`, `infoPhone`
  - Website/Skills: `infoLinkedIn`, `#info.skills`
  - Work history (repeatable): `btnAddWorkHistory` → `workHistoryCompanyName{i}`, `workHistoryPosition{i}`, `txt-workHistory-startDate-{i}`, `txt-workHistory-endDate-{i}`, `#workHistory.currentlyWorkHere`
  - Education (repeatable): `btnAddEducationHistory` → `educationHistoryAreaOfStudy{i}`, `txt-educationHistory-graduationDate-{i}`, `degreeId`
  - Address: `public-site-address-country-input-base`, `…-address-1` (+`-autocomplete-item-0`), `…-address-2`, `…-city`/`…-locality`, `…-zip`/`…-postal-code`, `…-us-state-input-base`
  - EEO: gender (label-anchored XPath), ethnicity (Hispanic / Not Hispanic via dropdown, or decline checkbox), `#veteranStatusIdYes/No/Decline`, `#disabilityStatusIdYes/No/Decline`
  - Navigation: `btnNext`, `btnSubmit` (gated by `autoClickNextPage` / `autoSubmit`)
- **SPA-aware**: MutationObserver (18×) + `setInterval` (10×) + `location.href` watching (46×) to re-detect the current step and re-run.
- **Free-text**: mounts a "Generate Response" button on textareas (user-triggered), not auto-filled.

Confirmed against live screenshots of a Workday "My Information" + "My Experience"
form: `How Did You Hear About Us?*`, `Country`, `First/Last Name`, `Address 1/2`,
`City`, `State`, `Postal Code`, `Phone Device Type*` (= "Mobile"), `Country Phone
Code*` (= "United States of America (+1)"), `Phone Number`; then Work Experience
blocks (Job Title, Company, Location, "I currently work here", From/To MM/YYYY,
Role Description), Education, Languages, Skills, Resume/CV upload, Websites.

---

## 3. Data architecture (the critical part)

The Workday work-experience block needs: **company, title, location, start
(MM/YYYY), end (MM/YYYY), currently-here, description**. Sourcing these is the
hard part because of the two resume options (original vs tailored).

### 3.1 Current storage (verified)

- **Original resume work experience - fully structured.**
  `users.work_experience` (JSON list), schema `WorkExperienceBlock`
  (`app/models/profile_schemas.py:17-29`):
  `company_name, job_title, period_start, period_end, location, job_type, description`.
  "Currently here" = empty `period_end` (rendered "Present").

- **Tailored resume content - persisted, but missing temporal/location fields.**
  `resume_build_results.tailored_resume_data` (JSON) (`app/models/database.py:305`).
  Each tailored work block has only:
  `company_name, job_title, project_name, project_description, bullets[]`.
  No `period_start/end`, no `location`. Dropped during tailoring
  (`app/services/job_match_service.py`, prompt `app/prompts/job_match_phase_b_prompt.py`).
  The tailored list has exactly one entry per profile company, in profile order.

- **`profile_openai_cache`** is a flattened TEXT blob (LLM context only), not a
  structured source.

- **Resume files**: `resume_build_results.{resume_docx_path,resume_pdf_path,…}`;
  downloaded via `GET /jobs/valid/{job_id}/resume-build/download/{file_type}`.

### 3.2 The gap

The tailored resume is stored but **lacks dates + location**, which Workday
requires for each work-experience block.

### 3.3 Decision: ENRICH the tailoring output (chosen)

Make `tailored_resume_data` self-sufficient by having the Phase-B tailoring step
also emit the **immutable** temporal/location fields (copied verbatim from the
profile, exactly like company/title are already treated as immutable).

Changes:
1. **Prompt** (`app/prompts/job_match_phase_b_prompt.py`): extend each
   `work_experience` block contract to also include `period_start`, `period_end`,
   `location` (and `job_type`), instructed to copy them VERBATIM from the profile
   block (immutable; do not invent or alter).
2. **Parser** (`app/services/job_match_service.py` `_parse_tailored_resume`,
   ~lines 290-302): accept + validate the new fields; keep them on the stored dict.
3. **DOCX builder** (`app/services/resume_builder_service.py` `fill_resume_template`):
   verify it ignores/optionally uses the new keys (backward compatible - it keys
   on `project_name`/`project_description`/`bullets`). No behavior change required.

Backward-compatibility fallback (REQUIRED - pre-enrichment rows lack the fields):
- The autofill-profile assembler (§4.1) must **fall back to merging from the
  profile by company/order** when a tailored block is missing `period_start/end`
  or `location`. This also covers tailored content generated before this change
  and avoids forcing a global re-generation.

> Net effect: new tailored content is self-sufficient; old content still works via
> the merge fallback. The Workday engine consumes ONE shape regardless.

---

## 4. Backend changes (Phase 0)

### 4.1 New endpoint: canonical autofill profile

`GET /assistant/autofill-profile?job_id=<id>&resume_source=original|tailored`

Builds and returns the merged, structured object the engine maps from. The
extension caches it when the user opens a job.

Assembly:
- Static fields (name, contact, address, education, skills, websites, EEO) ←
  `users.*` structured columns.
- `workExperience`:
  - `resume_source=original` → directly from `users.work_experience`.
  - `resume_source=tailored` → tailored narrative (title/description/bullets) from
    `tailored_resume_data.work_experience`, JOINED with dates/location from
    `users.work_experience` by company/position order. (After §3.3 enrichment,
    dates/location come straight from the tailored block; the join is the fallback.)
- Dates normalized to `MM/YYYY` for Workday.
- Sensible defaults reused from the existing LLM autofill prompt logic
  (US citizen, gender Male, ethnicity Asian, Hispanic No, not-a-veteran,
  no-disability, authorized + no sponsorship, `howDidYouHear = "LinkedIn"`,
  `phoneDeviceType = "Mobile"`).

Response schema (canonical):
```json
{
  "name": { "first": "", "last": "", "preferred": "" },
  "contact": { "email": "", "phone": "", "phoneCountryCode": "1", "phoneDeviceType": "Mobile" },
  "address": { "line1": "", "line2": "", "city": "", "state": "", "postalCode": "", "country": "United States of America" },
  "websites": { "linkedin": "", "github": "", "other": "" },
  "skills": ["..."],
  "workExperience": [
    { "company": "", "title": "", "location": "", "startMMYYYY": "", "endMMYYYY": "", "current": false, "description": "" }
  ],
  "education": [
    { "school": "", "degree": "", "fieldOfStudy": "", "startMMYYYY": "", "endMMYYYY": "", "gpa": "" }
  ],
  "eeo": { "gender": "Male", "ethnicity": "Asian", "hispanicLatino": false, "veteran": false, "disability": false, "authorized": true, "sponsorship": false },
  "howDidYouHear": "LinkedIn"
}
```

### 4.2 Resume/CV file

Reuse the existing download endpoint; the engine attaches `resume_pdf` (or
`resume_docx`) - the tailored or original file per the user's resume-source choice.

---

## 5. Extension integration (routing layer)

Already in place from the Greenhouse work:
- `extension/src/engines.js`: `ENGINES.workday` (`mode: "workday"`, `scripts: "workday"`).
  → Flip `available: true` when Phase 1 lands.
- `extension/background.js`: register the bundle:
  ```js
  ENGINE_SCRIPTS.workday = [
    "content/workday/wd-dom.js",
    "content/workday/wd-steps.js",
    "content/workday/wd-engine.js",
    "content/workday/wd-content.js",
  ];
  ```
- `extension/src/app.js`: branch on `engine.mode`:
  - `"select"` → existing Greenhouse flow (unchanged).
  - `"workday"` → no picker UI; fetch the canonical profile (§4.1), inject the
    workday bundle, send `WD_RUN` with the profile + options, render a step/progress
    panel. Resume-source toggle (original/tailored) lives here.

---

## 6. Content engine design (`extension/content/workday/`)

- **`wd-dom.js`** - primitives (mirror SpeedyApply):
  - `setText(selector, value)` - React-safe (focus + key events + native setter + input/change).
  - `toggle(selector, on)` - click radio/checkbox only if state differs.
  - `selectDropdown(baseSelector, value)` - open `…-input-base`, wait for
    `[role="listbox"] .menu-list` / `promptOption`, click option whose text matches.
  - `selectNative(selector, value)` - native `<select>`, wait for options to populate.
  - `xpath(expr, root?)`, `waitFor(selectorOrXpath, timeoutMs)`, `delay(ms)`.
- **`wd-steps.js`** - declarative selector map per step (§7) + repeatable-section
  logic (click Add, index `{i}`, date format `MM/YYYY`).
- **`wd-engine.js`** - step detector (by presence of `data-automation-id`s) +
  runner; fills the visible step; reports progress; optional auto-advance.
- **`wd-content.js`** - entry: MutationObserver + URL-change watch; receives
  `WD_RUN`; re-runs on step changes; idempotent (skip already-filled inputs).

---

## 7. Field mapping

### My Information
| Field | Selector | Value |
|---|---|---|
| How Did You Hear About Us?* | dropdown/multiselect | `howDidYouHear` |
| Country | `…address-country-input-base` | `address.country` |
| First / Last Name | `infoFirstName` / `infoLastName` | `name.first/last` |
| Address 1/2 | `…address-address-1` / `…-2` | `address.line1/line2` |
| City | `…address-city` / `…-locality` | `address.city` |
| State | `…address-us-state-input-base` | `address.state` |
| Postal Code | `…address-zip` / `…-postal-code` | `address.postalCode` |
| Phone Device Type* | dropdown | `contact.phoneDeviceType` ("Mobile") |
| Country Phone Code* | multiselect chip | "United States of America (+1)" |
| Phone Number* | `infoPhone` / `infoCellPhone` | local digits only |

### My Experience (uses merged `workExperience[i]`)
| Field | Selector (indexed by `i`) | Value |
|---|---|---|
| Add block | `btnAddWorkHistory` ("Add Another") | - |
| Job Title | `workHistoryPosition{i}` | `title` |
| Company | `workHistoryCompanyName{i}` | `company` |
| Location | (Workday location input) | `location` |
| I currently work here | `#workHistory.currentlyWorkHere` | `current` (toggle) |
| From | `txt-workHistory-startDate-{i}` | `startMMYYYY` |
| To | `txt-workHistory-endDate-{i}` | `endMMYYYY` (skip if `current`) |
| Role Description | textarea | `description` |
| Education | `btnAddEducationHistory` + indexed | `education[i]` |
| Skills | type-to-add input | `skills[]` loop |
| Resume/CV | file input | tailored/original PDF or DOCX |

### Voluntary Disclosures / Self Identify
| Field | Selector | Value |
|---|---|---|
| Gender | label-anchored dropdown | `eeo.gender` |
| Ethnicity / Race | dropdown / checkbox | `eeo.ethnicity`, `eeo.hispanicLatino` |
| Veteran | `#veteranStatusIdYes/No/Decline` | `eeo.veteran` |
| Disability | `#disabilityStatusIdYes/No/Decline` | `eeo.disability` |

---

## 8. Phased rollout

| Phase | Scope | Key files |
|---|---|---|
| 0 | Data layer: enrich tailoring (prompt+parser) for dates/location; `GET /assistant/autofill-profile` (+ merge fallback); extension caches it on job open | `job_match_phase_b_prompt.py`, `job_match_service.py`, `assistant_routes.py`, `extension/src/{api,app}.js` |
| 1 | `wd-dom.js` primitives + step detection + **My Information**; flip `engines.workday.available=true`; `app.js` `mode:"workday"` branch + progress panel | `extension/content/workday/*`, `engines.js`, `background.js`, `app.js` |
| 2 | **My Experience** - work history + education (repeatable, indexed, `MM/YYYY`), Skills, Resume/CV upload | `wd-steps.js`, `wd-engine.js` |
| 3 | **Voluntary Disclosures** (EEO) + **Application Questions** (dropdowns/radios) | `wd-steps.js` |
| 4 | Auto-advance (`btnNext`) + review-page detection; **auto-submit OFF by default** | `wd-engine.js` |
| 5 | Free-text questions → reuse existing LLM autofill for unmapped `<textarea>`s only | `app.js`, `assistant_routes.py` |

---

## 9. Risks / watch-items

- **Tenant variants**: `data-automation-id`s are stable but a few differ by Workday
  version - use the `A or B` fallback pattern (e.g. `…-city` *or* `…-locality`,
  `…-zip` *or* `…-postal-code`).
- **Dropdown timing**: open input-base, wait for `[role="listbox"]`, match option
  text (lowercased); needs `waitFor` + small delay.
- **Address autocomplete**: fill line1, wait ~750ms, click first autocomplete item.
- **Date format**: Workday expects `MM/YYYY`; normalize in §4.1.
- **Tailored/profile join**: rely on company-order alignment; guard with a
  `company_name` match + skip on mismatch.
- **Old tailored rows**: lack dates/location → §3.3 merge fallback covers them.
- **Multi-frame**: keep `all_frames` injection.
- **Anti-bot / safety**: human-like delays; auto-submit off by default.

---

## 10. Open questions / defaults to confirm

- "How Did You Hear About Us?" default → "LinkedIn" (configurable?).
- Phone Device Type default → "Mobile".
- Should the resume-source (original vs tailored) be a per-run toggle in the panel,
  or follow the existing global `application_resume_source` setting?
- Education `degree`/`fieldOfStudy` source: profile `education[]` shape vs Workday
  degree dropdown values (may need a small mapping table).
