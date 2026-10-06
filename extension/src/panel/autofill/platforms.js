// Per-platform preparation steps that run before (or between) generic form
// fills: repeating education rows, consent overlays, multi-step portals.

import * as api from "../../api.js";
import * as storage from "../../storage.js";
import { setAutofill, state } from "../state.js";
import { fetchRoleFile } from "./form.js";
import { debugLog, delay, getAutofillProfile, tabBroadcast, tabSend } from "./shared.js";

// Greenhouse "Discipline" is a fixed-taxonomy dropdown that rarely contains a
// candidate's actual discipline, so (mirroring the Workday standard field-of-
// study) we always set it to one standard value rather than deriving it.
const GREENHOUSE_DEFAULT_DISCIPLINE = "Computer Science";

// Greenhouse: add a repeating education row per profile entry (Workday-style)
// and fill School/Degree/Discipline DETERMINISTICALLY, one control at a time,
// BEFORE the generic fill. Doing it per-row avoids the generic harvest opening
// every education dropdown at once (which stacks the menus open and leaves
// School/Degree unselected). Filled controls then report filled, so the LLM
// pass skips them. Best-effort: a fetch failure just fills Discipline on the
// existing row(s).
export async function prepareGreenhouseEducation(tabId) {
  if (!state.job || !state.job.job_id || tabId == null) return;  let entries = [];
  try {
    const profile = await getAutofillProfile(state.job.job_id);
    if (Array.isArray(profile.education)) {
      entries = profile.education.map((e) => ({
        school: (e && (e.school || e.university_name)) || "",
        degree: (e && e.degree) || "",
      }));
    }
  } catch {
    entries = [];
  }
  const res = await tabSend(tabId, {
    type: "AF_GH_PREP",
    entries,
    discipline: GREENHOUSE_DEFAULT_DISCIPLINE,
  });
  // The frame replies once rows are filled; give React a beat to commit them.
  if (res && res.ok) await delay(300);
}

// ApplyToJob (JazzHR): reveal the hidden resume file input before extraction so
// the engine claims it and the file driver can attach the resume PDF. Mirrors
// the Greenhouse education prep.
export async function prepareApplyToJob(tabId) {
  if (tabId == null) return;
  await tabSend(tabId, { type: "AF_ATJ_PREP" });
  await delay(400);
}

// Manatal (careers-page.com): tick the required terms/privacy consent checkbox
// before extraction so it is already filled for the LLM pass.
export async function prepareManatal(tabId) {
  if (tabId == null) return;
  await tabSend(tabId, { type: "AF_MANATAL_PREP" });
  await delay(200);
}

// Generic custom career pages: click privacy/terms Accept buttons (e.g. "I ACCEPT")
// and tick consent checkboxes before discovery/extract. cleanForLLM strips
// <button>, so this cannot be left to the LLM. No-op on known ATS hosts.
export async function prepareGeneric(tabId) {
  if (tabId == null) return { clicked: 0, ticked: 0, fileWidgets: 0 };
  let res = null;
  try {
    res = await tabSend(tabId, { type: "AF_GENERIC_PREP" });
  } catch {
    res = null;
  }
  await delay(300);
  return {
    clicked: (res && res.clicked) || 0,
    ticked: (res && res.ticked) || 0,
    fileWidgets: (res && res.fileWidgets) || 0,
  };
}

// JobDiva: Apply Now → Quick Apply (No Account) → wait for My Application modal,
// then tick SMS/consent checkboxes. Must finish before AF_AUTOSELECT because the
// form only mounts ~2s after Quick Apply (longer than the in-page retry window).
export async function prepareJobDiva(tabId) {
  if (tabId == null) return { ready: false };
  let res = null;
  try {
    res = await tabSend(tabId, { type: "AF_JD_PREP" });
  } catch {
    res = null;
  }
  await delay(400);
  return {
    ready: !!(res && res.ready),
    ticked: (res && res.ticked) || 0,
    reason: res && res.reason,
  };
}

export async function submitJobDiva(tabId) {
  if (tabId == null) return { clicked: 0, submitted: false, errors: [] };
  let res = null;
  try {
    res = await tabSend(tabId, { type: "AF_JD_SUBMIT" });
  } catch {
    res = null;
  }
  return {
    clicked: (res && res.clicked) || 0,
    submitted: !!(res && res.submitted),
    stillOnForm: !!(res && res.stillOnForm),
    errors: (res && Array.isArray(res.errors) && res.errors) || [],
  };
}

// Jobvite: attach the tailored resume (required) and cover letter (optional)
// through the jv-add-attachment widget before extraction. Done first so that if
// Jobvite parses the resume into any fields, the subsequent LLM text pass still
// overwrites them with the tailored values. Silently no-ops when a document was
// never built for this job or the widget is not on this step.
export async function prepareJobvite(tabId) {
  if (tabId == null || !state.job || !state.job.job_id) return;
  const jobId = state.job.job_id;
  const cache = {};
  try {
    const resumeFile = await fetchRoleFile(jobId, "resume", "", cache);
    if (resumeFile) {
      const r = await tabSend(tabId, { type: "AF_JV_UPLOAD_RESUME", file: resumeFile });
      if (r && r.uploaded) debugLog("[autofill] Jobvite resume attached");
      else console.warn("[autofill] Jobvite resume attach not confirmed:", r);
    }
  } catch (e) {
    console.warn("[autofill] Jobvite resume attach failed:", (e && e.message) || e);
  }
  try {
    const coverFile = await fetchRoleFile(jobId, "cover_letter", "", cache);
    if (coverFile) {
      const c = await tabSend(tabId, { type: "AF_JV_UPLOAD_COVER", file: coverFile });
      if (c && c.uploaded) debugLog("[autofill] Jobvite cover letter attached");
    }
  } catch (e) {
    console.warn("[autofill] Jobvite cover letter attach failed:", (e && e.message) || e);
  }
  await delay(300);
}

// ── iCIMS ────────────────────────────────────────────────────────────────────

// A password satisfying the rule iCIMS states in the field's own title
// attribute: "Minimum 8 characters, 1 alphabetic, 1 lowercase, 1 uppercase,
// 1 numeric, 1 special character(s)". Ambiguous glyphs (l/1/O/0) are left out so
// the candidate can retype it from the panel without misreading it.
function generatePortalPassword() {
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const special = "!@#$%^&*";
  const all = lower + upper + digits + special;
  const bytes = new Uint32Array(20);
  crypto.getRandomValues(bytes);
  const chars = [
    upper[bytes[0] % upper.length],
    lower[bytes[1] % lower.length],
    digits[bytes[2] % digits.length],
    special[bytes[3] % special.length],
  ];
  for (let i = 4; i < 16; i++) chars.push(all[bytes[i] % all.length]);
  // Shuffle so the four guaranteed classes are not always in the same slots.
  const swap = new Uint32Array(chars.length);
  crypto.getRandomValues(swap);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = swap[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

async function tabHost(tabId) {
  if (tabId == null) return "";
  try {
    const tab = await chrome.tabs.get(tabId);
    return new URL(tab.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Re-inject the engine bundle after the page navigated under us (iCIMS submits
// the form to upload a resume, which destroys every content script).
async function reinjectEngine(tabId, eng) {
  if (tabId == null) return false;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "AUTOFILL_INJECT",
      tabId,
      engine: (eng && eng.scripts) || "greenhouse",
    });
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

// Ask every frame whether it hosts the iCIMS resume field; the one that does
// answers with { present, attached, parsing, needsCredentials }.
export async function icimsResumeState(tabId) {
  if (tabId == null) return null;
  let replies = [];
  try {
    replies = await tabBroadcast(tabId, { type: "AF_ICIMS_RESUME_STATE" });
  } catch {
    return null;
  }
  for (const r of replies || []) {
    if (r && r.ok && r.present) return r;
  }
  return null;
}

// iCIMS uploads the resume FIRST, not last.
//
// The resume input's own onchange runs
//   this.form.action = this.form.action + '&uploadResume=1'; this.form.submit();
// and the page states "Existing data in the form will be replaced". So the
// upload navigates the tab and iCIMS re-renders the whole profile server-side,
// pre-filled from the parsed resume (the fields carrying bgtparse="true").
// Anything written beforehand is destroyed, which is why this runs before the
// very first extraction instead of after the last write like Lever/Ashby.
//
// Returns true when the caller must re-discover the form (the page reloaded).
export async function uploadIcimsResumeFirst(tabId, eng, ctx) {
  if (tabId == null || !state.job || !state.job.job_id) return false;
  const before = await icimsResumeState(tabId);
  if (!before) return false; // this step has no resume field (later application step)
  if (before.attached) return false; // already uploaded on an earlier run

  setAutofill({ runStatus: "Uploading your resume…" });
  const cache = {};
  const file = await fetchRoleFile(state.job.job_id, "resume", "", cache);
  if (!file) {
    ctx.needsUser.push({
      cid: "icims-resume",
      label: "Resume",
      reason:
        "Upload it yourself before filling anything else - no generated resume exists for this job, and iCIMS reloads the page and replaces the form when a resume is attached.",
    });
    return false;
  }

  try {
    // Broadcast: the upload navigates the page, so the reply usually never
    // arrives. A dead message channel here is the expected outcome, not a error.
    await tabBroadcast(tabId, { type: "AF_ICIMS_UPLOAD_RESUME", file });
  } catch {
    /* page is navigating */
  }

  setAutofill({ runStatus: "Waiting for iCIMS to parse your resume…" });
  setAutofill({ primaryFrameId: null });
  await delay(1500);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await reinjectEngine(tabId, eng);
    const st = await icimsResumeState(tabId);
    if (st && st.attached && !st.parsing) return true;
    await delay(1200);
  }
  // The reload never settled. Re-discovering is still the right move: the page
  // may be mid-render and the old handles are detached either way.
  console.warn("[autofill] iCIMS resume upload did not confirm within 45s");
  return true;
}

// Ask every frame where this iCIMS page sits in the application itinerary.
// Only the frame hosting the form answers (portals can be iframed).
export async function icimsStage(tabId) {
  if (tabId == null) return null;
  let replies = [];
  try {
    replies = await tabBroadcast(tabId, { type: "AF_ICIMS_STAGE" });
  } catch {
    return null;
  }
  let best = null;
  let bestScore = -1;
  for (const r of replies || []) {
    if (!r || !r.ok || !r.icims) continue;
    // The frame hosting the live step has both the itinerary and an advance
    // button; prefer it over portal chrome that happens to carry only one.
    const score = (r.hasSubmit ? 2 : 0) + (r.stepsPresent ? 1 : 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

// Advance one iCIMS step: click the step's Submit, ride out the full-document
// navigation, re-inject the engine into the new page and confirm we actually
// moved. Unlike SmartRecruiters/Breezy (SPAs that re-render in place), every
// iCIMS step is a real POST that destroys every content script - so "did it
// work?" can only be answered by the freshly injected script on the next page,
// exactly the way uploadIcimsResumeFirst rides out the resume upload.
//
// Returns { advanced, stage, errors }.
export async function icimsAdvance(tabId, eng, fromStage) {
  const before = fromStage || (await icimsStage(tabId));
  if (!before || !before.hasSubmit) return { advanced: false, stage: before, errors: [] };

  try {
    // The click navigates, so the reply is expected to be lost, not an error.
    await tabBroadcast(tabId, { type: "AF_ICIMS_SUBMIT" });
  } catch {
    /* page is navigating */
  }

  // Handles from the old document are dead and frame ids change on reload.
  setAutofill({ fields: [], primaryFrameId: null });
  await delay(1200);

  const deadline = Date.now() + 45000;
  let last = null;
  while (Date.now() < deadline) {
    await reinjectEngine(tabId, eng);
    const st = await icimsStage(tabId);
    if (st) {
      last = st;
      // Moving to a later step is the only proof the POST was accepted; a step
      // that re-renders in place was rejected and now carries the reasons.
      if (before.step && st.step && st.step > before.step) return { advanced: true, stage: st, errors: [] };
      if (st.errors && st.errors.length) return { advanced: false, stage: st, errors: st.errors };
      // No step indicator to compare: fall back to the page's own identity.
      if (!before.step && st.heading && st.heading !== before.heading) {
        return { advanced: true, stage: st, errors: [] };
      }
    }
    await delay(1200);
  }
  return {
    advanced: false,
    stage: last,
    errors: (last && last.errors) || [],
    timedOut: true,
  };
}

// iCIMS pre-pass, run after the resume upload and before extraction. Two field
// groups are written deterministically from the profile because the model
// provably cannot answer them correctly (see content/engine/icims.js):
//
//  * the phone block - Number is autocomplete="tel-national" and iCIMS' own
//    resume parser pre-fills it with the full international string, which reads
//    as "filled" so the generic pass never corrects it; Phone Country Code is a
//    searchable AJAX dropdown offered with no options, which the backend then
//    answers with a bare dial code that matches nothing in the list.
//  * the "Create a login" block - the two password boxes must hold the SAME
//    value and satisfy the complexity rule in their own title attribute.
//
// Both need the canonical autofill profile, so it is fetched once here.
export async function prepareIcims(tabId, ctx) {
  if (tabId == null) return;
  const host = await tabHost(tabId);
  if (!host) return;
  const userId = state.user && state.user.user_id;

  // A multi-step application runs this prep once per step; the profile is the
  // same every time, so fetch it once per run and reuse it across the steps.
  let profile = null;
  if (ctx && "icimsProfile" in ctx) {
    profile = ctx.icimsProfile;
  } else if (state.job && state.job.job_id) {    try {
      profile = await getAutofillProfile(state.job.job_id);
    } catch {
      profile = null;
    }
    if (ctx) ctx.icimsProfile = profile;
  }
  const contact = (profile && profile.contact) || {};
  const address = (profile && profile.address) || {};

  try {
    const phoneRes = await tabSend(tabId, {
      type: "AF_ICIMS_PHONE",
      phone: contact.phone || "",
      countryCode: contact.phoneCountryCode || "",
      country: address.country || "",
    });
    if (phoneRes && phoneRes.ok) {
      debugLog("[autofill] iCIMS phone prep:", phoneRes);
      // The dial-code dropdown is required; if neither the profile nor the
      // widget search could resolve it, iCIMS rejects the whole phone block on
      // submit, so say so instead of letting it fail silently.
      if (phoneRes.codePresent && !phoneRes.code) {
        ctx.needsUser.push({
          cid: "icims-phone-country-code",
          label: "Phones - Phone Country Code",
          reason: "Pick your dialing code - iCIMS rejects the phone block without it.",
        });
      }
    }
  } catch {
    /* no phone block on this page */
  }
  await delay(200);

  // The login is the candidate's email (the field is autocomplete="username"),
  // so it matches the Email field the LLM pass writes.
  let login = contact.email || "";
  if (!login) {
    const cached = state.cache && state.cache.profile;
    login = (cached && cached.email) || (state.user && state.user.email) || "";
  }

  let creds = null;
  try {
    creds = await storage.getAtsCredential(userId, host);
  } catch {
    creds = null;
  }
  if (!creds) {
    creds = { login, password: generatePortalPassword() };
  } else if (login && !creds.login) {
    creds = { ...creds, login };
  }

  let res = null;
  try {
    res = await tabSend(tabId, { type: "AF_ICIMS_CREDENTIALS", login: creds.login, password: creds.password });
  } catch {
    res = null;
  }
  await delay(200);
  // Nothing written means this page has no "Create a login" block (or the
  // candidate is already signed in), so there is no account to remember.
  if (!res || !res.ok || !(res.login || res.password)) return;

  try {
    await storage.saveAtsCredential(userId, host, creds);
  } catch {
    /* storage is best-effort; the password is still shown below */
  }
  if (!ctx.needsUser.some((x) => x.cid === "icims-credentials")) {
    ctx.needsUser.push({
      cid: "icims-credentials",
      label: `${host} account password`,
      reason: `Save this in your password manager - iCIMS created an account for you. Login: ${creds.login || "(see the form)"} / Password: ${creds.password}`,
    });
  }
}

// RecruiterFlow: add a repeating Experience/Education row per profile entry
// (Workday-style) and fill Company/Title/School/Degree/dates + Country
// deterministically, and tick the required consent box, BEFORE the generic fill.
// Filled controls then report filled, so the LLM pass skips them. Best-effort:
// a fetch failure just lets the generic pass handle whatever it can.
export async function prepareRecruiterFlow(tabId) {
  if (!state.job || !state.job.job_id || tabId == null) return;  let experience = [];
  let education = [];
  let country = "";
  try {
    const profile = await getAutofillProfile(state.job.job_id);
    if (Array.isArray(profile.workExperience)) {
      experience = profile.workExperience.map((w) => ({
        company: (w && w.company) || "",
        title: (w && w.title) || "",
        start: (w && w.startMMYYYY) || "",
        end: (w && w.endMMYYYY) || "",
        current: !!(w && w.current),
      }));
    }
    if (Array.isArray(profile.education)) {
      education = profile.education.map((e) => ({
        school: (e && (e.school || e.university_name)) || "",
        degree: (e && e.degree) || "",
        start: (e && e.startMMYYYY) || "",
        end: (e && e.endMMYYYY) || "",
      }));
    }
    country = (profile && profile.address && profile.address.country) || "";
  } catch {
    experience = [];
    education = [];
    country = "";
  }
  await tabSend(tabId, { type: "AF_RF_PREP", experience, education, country });
  // Let newly mounted rows / committed selections settle before extraction.
  await delay(500);
}

// SmartRecruiters: add + Save a repeating Experience/Education entry per profile
// entry (Workday-style: Add -> fill -> Save) and tick the required consent box,
// BEFORE the generic fill. The repeating subtrees are excluded from generic
// detection, so the prep owns them; personal info / resume are left to the LLM
// pass. Best-effort: a fetch failure just lets the generic pass handle the rest.
export async function prepareSmartRecruiters(tabId) {
  if (!state.job || !state.job.job_id || tabId == null) return;  let experience = [];
  let education = [];
  let home = null;
  try {
    const profile = await getAutofillProfile(state.job.job_id);
    const addr = (profile && profile.address) || {};
    home = {
      city: addr.city || "",
      state: addr.state || "",
      country: addr.country || "",
      postalCode: addr.postalCode || addr.postal_code || "",
    };
    if (Array.isArray(profile.workExperience)) {
      experience = profile.workExperience.map((w) => ({
        company: (w && w.company) || "",
        title: (w && w.title) || "",
        location: (w && w.location) || "",
        description: (w && w.description) || "",
        start: (w && w.startMMYYYY) || "",
        end: (w && w.endMMYYYY) || "",
        current: !!(w && w.current),
      }));
    }
    if (Array.isArray(profile.education)) {
      education = profile.education.map((e) => ({
        school: (e && (e.school || e.university_name)) || "",
        degree: (e && e.degree) || "",
        major: (e && e.fieldOfStudy) || "",
        description: (e && e.description) || "",
        start: (e && e.startMMYYYY) || "",
        end: (e && e.endMMYYYY) || "",
      }));
    }
  } catch {
    experience = [];
    education = [];
  }
  await tabSend(tabId, { type: "AF_SR_PREP", experience, education, home });
  // Repeating rows mount + save asynchronously; let the form settle before extract.
  await delay(600);
}

// Workable: add + Update a repeating Education/Experience entry per profile
// entry BEFORE the generic fill. Repeating subtrees are excluded from generic
// detection; personal info / summary / cover letter go to the LLM pass.
export async function prepareWorkable(tabId) {
  if (!state.job || !state.job.job_id || tabId == null) return;  let experience = [];
  let education = [];
  let address = {};
  let eeo = {};
  try {
    const profile = await getAutofillProfile(state.job.job_id);
    address = (profile && profile.address) || {};
    eeo = (profile && profile.eeo) || {};
    if (Array.isArray(profile.workExperience)) {
      experience = profile.workExperience.map((w) => ({
        company: (w && w.company) || "",
        title: (w && w.title) || "",
        // Profile WorkExperienceBlock has no industry field, always "" unless
        // a future API adds it. Logged in content script when skipped.
        industry: (w && w.industry) || "",
        description: (w && w.description) || "",
        start: (w && w.startMMYYYY) || "",
        end: (w && w.endMMYYYY) || "",
        current: !!(w && w.current),
      }));
    }
    if (Array.isArray(profile.education)) {
      education = profile.education.map((e) => ({
        school: (e && (e.school || e.university_name)) || "",
        degree: (e && e.degree) || "",
        field_of_study: (e && e.fieldOfStudy) || "",
        start: (e && e.startMMYYYY) || "",
        end: (e && e.endMMYYYY) || "",
      }));
    }
  } catch {
    experience = [];
    education = [];
    address = {};
    eeo = {};
  }
  try {
    debugLog("[autofill] prepareWorkable payload", {
      exp: experience.length,
      edu: education.length,
      address: {
        city: address.city || "",
        state: address.state || "",
        country: address.country || "",
      },
      expDates: experience.map((w, i) => ({
        i,
        title: w.title,
        start: w.start,
        end: w.end,
        current: w.current,
        industry: w.industry,
      })),
      sponsorship: eeo.sponsorship,
    });
  } catch {}
  // Seed platform answer-cache from profile EEO so sponsorship radios are
  // clicked in prepareCachedAnswers before extract (first visit has no store).
  try {
    const userId = state.user && state.user.user_id;
    if (userId != null && typeof eeo.sponsorship === "boolean") {
      const pairs = (await storage.getAnswerCache(userId, "workable")) || {};
      if (!pairs.sponsorship) {
        pairs.sponsorship = eeo.sponsorship ? "Yes" : "No";
        await storage.saveAnswerPairs(userId, "workable", { sponsorship: pairs.sponsorship });
        debugLog("[autofill] prepareWorkable seeded sponsorship cache:", pairs.sponsorship);
      }
    }
  } catch (err) {
    console.warn("[autofill] prepareWorkable sponsorship seed failed", err && err.message);
  }
  await tabSend(tabId, { type: "AF_WB_PREP", experience, education, address });
  await delay(600);
}

// Fill a cover-letter textarea with the AI-generated cover letter body (the same
// text used to build the cover letter DOCX), so platforms that take a pasted
// cover letter get it verbatim instead of an LLM re-write. No-op when no cover
// letter was generated for this job. Runs before extraction so the filled
// textarea reports filled and the LLM pass skips it.
export async function prepareCoverLetter(tabId) {
  if (!state.job || !state.job.job_id || tabId == null) return;  let text = "";
  try {
    const profile = await getAutofillProfile(state.job.job_id);
    text = (profile && profile.coverLetter) || "";
  } catch {
    text = "";
  }
  if (!text) return;
  await tabSend(tabId, { type: "AF_FILL_COVER_LETTER", text });
  await delay(200);
}
