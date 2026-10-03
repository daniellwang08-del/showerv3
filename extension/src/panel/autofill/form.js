// Form autofill for Greenhouse-style engines: discover the application form,
// extract per-control specs, ask the backend LLM for values, write them back,
// and walk multi-page flows (Lever, Workable, SmartRecruiters, iCIMS, ...).

import * as api from "../../api.js";
import { autofillPermissionOrigins, resolveEngine } from "../../engines.js";
import * as storage from "../../storage.js";
import * as tabMsg from "../../tab-messaging.js";
import { completeJob } from "../actions/job.js";
import { emptyAutofill, setAutofill, setState, state } from "../state.js";
import { getWorkTab } from "../tabs.js";
import { toast } from "../toast.js";
import {
  icimsAdvance,
  icimsStage,
  prepareApplyToJob,
  prepareCoverLetter,
  prepareGeneric,
  prepareGreenhouseEducation,
  prepareIcims,
  prepareJobDiva,
  prepareJobvite,
  prepareManatal,
  prepareRecruiterFlow,
  prepareSmartRecruiters,
  prepareWorkable,
  submitJobDiva,
  uploadIcimsResumeFirst,
} from "./platforms.js";
import {
  autofillFrameId,
  buildPreferences,
  clearProfileCache,
  debugLog,
  delay,
  tabBroadcast,
  tabSend,
} from "./shared.js";
import { abortWorkdayRun, startWorkdayAutofill } from "./workday.js";

// Collects per-frame AF_FIELDS responses during an extraction run.
let extractCollector = null;
// Resolves when the content script reports it finished a write pass.
let writeWaiter = null;
// Monotonic id correlating each AF_WRITE with its AF_WRITE_RESULT.
let writePassSeq = 0;

export async function startAutofill() {
  try {
    const tab = await getWorkTab();
    if (!tab || tab.id == null || !/^https?:/i.test(tab.url || "")) {
      toast("Open the job application page in the active tab first.");
      return;
    }
    try {
      new URL(tab.url);
    } catch {
      toast("Cannot read the page URL.");
      return;
    }
    // Route to the platform's engine using the LIVE application page URL (more
    // reliable than the snapshot URL). A platform with a reserved-but-unbuilt
    // dedicated engine (e.g. Workday) is not filled by the generic engine.
    const engine = resolveEngine({ snapshot: state.job && state.job.snapshot, pageUrl: tab.url });
    if (!engine.available) {
      toast(`${engine.label} engine is not available yet. ${engine.note || "It will get its own dedicated engine."}`);
      return;
    }
    // Host permission for the page (and embedded ATS iframe when applicable).
    const permOrigins = autofillPermissionOrigins(tab.url, engine.platform);
    if (!permOrigins.length) {
      toast("This page URL cannot be used for autofill (need an http/https application page).");
      return;
    }
    const granted = await chrome.permissions.request({ origins: permOrigins });
    if (!granted) {
      toast("Permission to read this page was denied.");
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "AUTOFILL_INJECT", tabId: tab.id, engine: engine.scripts });
    if (!res || !res.ok) {
      toast("Could not start autofill on this page.");
      return;
    }
    // Deterministic engines (Workday) fill straight from the canonical profile -
    // no manual region selection, no LLM.
    if (engine.mode === "workday") {
      await startWorkdayAutofill(tab, engine);
      return;
    }
    // Auto-discovery engines (Greenhouse): select the page's single application
    // container and fill it automatically - no manual field tagging.
    if (engine.autoDiscover) {
      setState({ autofill: { ...emptyAutofill(), active: true, discovering: true, tabId: tab.id, engine } });
      // JobDiva: open Quick Apply before discovery, the form only mounts after
      // Apply Now → Quick Apply (~2s), which is longer than AF_AUTOSELECT's retry.
      if (engine.platform === "jobdiva") {
        setAutofill({ runStatus: "Opening Quick Apply…" });
        const prep = await prepareJobDiva(tab.id);
        if (!prep.ready) {
          setAutofill({
            discovering: false,
            runStatus: null,
            error: "Could not open JobDiva Quick Apply on this page.",
          });
          return;
        }
      }
      // Generic custom career pages: accept privacy/terms overlays before scan so
      // the full application form is visible to AF_AUTOSELECT.
      if (engine.platform === "generic") {
        setAutofill({ runStatus: "Accepting terms…" });
        await prepareGeneric(tab.id);
      }
      try {
        // Prefer the Greenhouse embed iframe when the career page is only a shell.
        // Send AF_AUTOSELECT only there so the parent never runs a useless retry loop.
        const frames = await tabMsg.getTabFrames(tab.id);
        const ghFrame = tabMsg.pickGreenhouseFrame(frames);
        if (ghFrame && ghFrame.frameId != null) {
          setAutofill({ primaryFrameId: ghFrame.frameId });
          await tabMsg.sendTabMessage(tab.id, { type: "AF_AUTOSELECT" }, ghFrame.frameId);
        } else {
          await tabMsg.broadcastTabMessage(tab.id, { type: "AF_AUTOSELECT" });
        }
      } catch {
        /* ignore */
      }
      // Fallback in case no frame reports back (e.g. the form is missing): wait
      // past the in-page discovery retry window, then either fill what we found
      // or surface an error. JobDiva gets a longer window for the modal mount.
      const discoverMs = engine.platform === "jobdiva" ? 16000 : 3500;
      setTimeout(() => {
        if (!state.autofill.active || !state.autofill.discovering) return;
        if (state.autofill.fields.length) maybeAutoRun();
        else setAutofill({ discovering: false, error: "Could not find the application form on this page." });
      }, discoverMs);
      return;
    }
    await tabMsg.broadcastTabMessage(tab.id, { type: "AF_START" });
    setState({ autofill: { ...emptyAutofill(), active: true, picking: true, tabId: tab.id, engine } });
  } catch (err) {
    toast("Autofill could not start: " + ((err && err.message) || err));
  }
}

export async function teardownAutofill() {
  const af = state.autofill;
  await abortWorkdayRun(af ? af.tabId : null);
  if (af && af.tabId != null) {
    try {
      await tabBroadcast(af.tabId, { type: "AF_CLEAR" });
    } catch {
      /* tab may be gone */
    }
  }
  clearProfileCache();
  setState({ autofill: emptyAutofill() });
}

export async function cancelAutofill() {
  await teardownAutofill();
  setState({});
}

export async function removeAutofillField(handle) {
  const tabId = state.autofill.tabId;
  if (tabId != null) {
    try {
      const field = state.autofill.fields.find((f) => f.handle === handle);
      await tabSend(tabId, { type: "AF_REMOVE", handle }, field && field.frameId != null ? field.frameId : undefined);
    } catch {
      /* ignore */
    }
  }
  setAutofill({ fields: state.autofill.fields.filter((f) => f.handle !== handle) });
}

export async function resumePicking() {
  const tabId = state.autofill.tabId;
  if (tabId == null) return;
  try {
    await tabBroadcast(tabId, { type: "AF_START" });
  } catch {
    /* ignore */
  }
  setAutofill({ picking: true });
}

// Classify a field label into a stable identity / EEO / work-authorization /
// consent category, or null if it isn't one we remember. MUST stay identical to
// the copy in content/picker.js so cached keys line up. Order matters (work_auth
// keywords overlap citizenship).
function answerCategory(label) {
  const s = (label || "").toLowerCase();
  if (!s) return null;
  if (/\bgender\b|\bsex\b/.test(s)) return "gender";
  if (/hispanic|latino|latina|latinx/.test(s)) return "hispanic";
  if (/\brace\b|ethnic|nationalit/.test(s)) return "race";
  if (/veteran/.test(s)) return "veteran";
  if (/disab/.test(s)) return "disability";
  if (/sponsor/.test(s)) return "sponsorship";
  if (/citizen|authoriz|eligible to work|right to work|legally authorized/.test(s)) return "work_auth";
  if (/how did you hear|hear about (us|this|the)/.test(s)) return "how_hear";
  if (/\bconsent\b|acknowledg|i agree|\bterms\b|privacy/.test(s)) return "consent";
  return null;
}

// Select engines: replay remembered identity answers (EEO, work authorization,
// consent) BEFORE extraction. The page fills any control whose category we've
// cached, marking it filled, so the harvest + LLM pass skips it - no menu
// opening and no LLM round-trip for questions whose answer never changes.
// The cache is scoped to the engine's platform: option text learned on one ATS
// is never replayed on another (their option phrasing / value maps differ), so
// a new platform fills everything via the LLM until it builds its own cache.
async function prepareCachedAnswers(tabId, platform) {
  if (tabId == null) return;
  const userId = state.user && state.user.user_id;
  let pairs = {};
  try {
    pairs = await storage.getAnswerCache(userId, platform);
  } catch {
    pairs = {};
  }
  if (!pairs || !Object.keys(pairs).length) return;
  await tabSend(tabId, { type: "AF_APPLY_CACHE", pairs });
  await delay(400);
}

// Commit browser-autofilled values into the page's framework (React) state so a
// controlled form counts them as filled. Best-effort and side-effect-free on the
// visible text (it re-fires each input's own value), so it's safe for any engine.
async function commitPrefilled(tabId) {
  if (tabId == null) return;
  try {
    await tabSend(tabId, { type: "AF_COMMIT_PREFILLED" });
    await delay(150);
  } catch {
    /* ignore */
  }
}

// Auto-discovery: once the application container is registered, leave the
// discovering state and start filling. Guarded by the discovering flag so it
// fires exactly once even if several frames report back.
export function maybeAutoRun() {
  const af = state.autofill;
  if (!af.active || !af.discovering || af.running || !af.fields.length) return;
  setAutofill({ discovering: false });
  runAutofill();
}

// Ask the content script(s) to extract structured specs for the selected blocks.
function extractTimeoutMs(handles) {
  const fields = state.autofill.fields || [];
  let controls = 0;
  for (const f of fields) {
    if (!handles.length || handles.includes(f.handle)) controls += f.controlCount || 0;
  }
  // Each unfilled react-select harvest opens/closes a menu (~300–800ms). A 42-control
  // Greenhouse embed easily exceeds the old 4s cap; scale with control count.
  return Math.min(120000, Math.max(20000, 6000 + controls * 450));
}

function extractSpecs(tabId, handles) {
  return new Promise((resolve) => {
    const collected = new Map();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      extractCollector = null;
      resolve([...collected.values()]);
    };
    extractCollector = { expected: new Set(handles), collected, finish };
    const frameId = autofillFrameId();
    const timeoutMs = extractTimeoutMs(handles);
    if (tabId != null) {
      try {
        if (frameId != null) tabSend(tabId, { type: "AF_EXTRACT", handles }, frameId);
        else tabBroadcast(tabId, { type: "AF_EXTRACT", handles });
      } catch {
        /* ignore */
      }
    }
    setTimeout(finish, timeoutMs);
  });
}

// Cheap progressive-reveal probe (no option harvest / LLM html). Returns how
// many controls are still unfilled and not yet attempted. On messaging failure
// returns 1 so the caller still runs a full extract instead of stopping early.
async function countUnfilledControls(tabId, handles, attemptedKeys) {
  if (tabId == null) return 1;
  try {
    const resp = await tabSend(tabId, {
      type: "AF_COUNT_UNFILLED",
      handles,
      attemptedKeys: [...(attemptedKeys || [])],
    });
    if (!resp || resp.ok === false || typeof resp.count !== "number") return 1;
    return resp.count;
  } catch {
    return 1;
  }
}

function looksLikeResumeOrCoverLabel(label) {
  const t = String(label || "").toLowerCase();
  if (!t) return false;
  if (/\bcover\s*letter\b/.test(t)) return true;
  if (/\badditional\s*files?\b/.test(t)) return true;
  return /\b(resume|cv|curriculum\s*vitae)\b/.test(t);
}

function inferFileRoleFromLabel(label) {
  const t = String(label || "").toLowerCase();
  if (/\bcover\s*letter\b/.test(t)) return "cover_letter";
  // Grid Dynamics / CF7: section is "Additional files" with Add cover letter.
  if (/\badditional\s*files?\b/.test(t)) return "cover_letter";
  if (/\b(resume|cv|curriculum\s*vitae)\b/.test(t)) return "resume";
  return null;
}

/** Ensure file controls get resume/cover_letter roles from their labels when the model omits them. */
function normalizeFileRolesInResults(results, specs) {
  const labelByCid = {};
  const fileCids = new Set();
  for (const f of specs || []) {
    for (const c of f.controls || []) {
      if (!c || !c.is_file) continue;
      fileCids.add(c.cid);
      labelByCid[c.cid] = c.label || f.label || "";
    }
  }
  for (const r of results || []) {
    for (const c of r.controls || []) {
      if (!fileCids.has(c.cid)) continue;
      const role = String(c.file_role || "").toLowerCase();
      if (role === "resume" || role === "cover_letter") continue;
      const inferred = inferFileRoleFromLabel(labelByCid[c.cid]);
      if (inferred) c.file_role = inferred;
    }
  }
}

// Fetch a generated file for a role, preferring PDF (or whatever the field
// accepts), falling back to DOCX. Cached per file type. Returns null if neither
// exists (e.g. the cover letter was never built for this job).
export async function fetchRoleFile(jobId, role, accept, cache) {
  const acc = (accept || "").toLowerCase();
  const wantsDocxFirst = acc && !acc.includes("pdf") && (acc.includes("doc") || acc.includes("word"));
  const order = wantsDocxFirst
    ? [`${role}_docx`, `${role}_pdf`]
    : [`${role}_pdf`, `${role}_docx`];
  let lastErr = null;
  for (const fileType of order) {
    if (fileType in cache) {
      if (cache[fileType]) return cache[fileType];
      continue;
    }
    try {
      cache[fileType] = await api.downloadResumeFile(jobId, fileType);
      return cache[fileType];
    } catch (err) {
      lastErr = err;
      cache[fileType] = null;
      try {
        console.warn(`[autofill] download ${fileType} failed:`, (err && err.message) || err);
      } catch {}
    }
  }
  if (lastErr) cache.__lastError = lastErr;
  return null;
}

// Build a cid -> file map for file controls. Returns { files, missing } where
// missing lists file controls whose role file does not exist on the server.
async function fetchFilesForResults(jobId, results, specs) {
  const acceptByCid = {};
  const fileCids = new Set();
  for (const f of specs) {
    for (const c of f.controls || []) {
      if (c.is_file) {
        fileCids.add(c.cid);
        acceptByCid[c.cid] = c.accept || "";
      }
    }
  }
  const files = {};
  const missing = [];
  const cache = {};
  for (const r of results) {
    for (const c of r.controls || []) {
      if (!fileCids.has(c.cid)) continue;
      const role = c.file_role;
      if (role !== "resume" && role !== "cover_letter") continue; // no file for "other"
      const file = await fetchRoleFile(jobId, role, acceptByCid[c.cid], cache);
      if (file) files[c.cid] = file;
      else missing.push({ cid: c.cid, role });
    }
  }
  return { files, missing };
}

// Lever parses an uploaded resume and may overwrite name/email/phone - defer the
// resume file write until every text/select field has been filled.
function splitLeverResumeWrite(results, files) {
  let pending = null;
  const outResults = [];
  for (const r of results || []) {
    const controls = [];
    for (const c of r.controls || []) {
      if (c.file_role === "resume") {
        if (files && files[c.cid]) pending = { cid: c.cid, file: files[c.cid] };
        continue;
      }
      controls.push(c);
    }
    if (controls.length) outResults.push({ handle: r.handle, controls });
  }
  const outFiles = {};
  for (const [cid, fd] of Object.entries(files || {})) {
    if (!pending || cid !== pending.cid) outFiles[cid] = fd;
  }
  return { results: outResults, files: outFiles, pending };
}

// Ashby Yes/No is two toggle buttons: re-clicking deselects. Strip those from
// the post-resume reapply payload so resume parse restore cannot undo them.
function stripAshbyToggleControls(results) {
  const out = [];
  for (const r of results || []) {
    const controls = (r.controls || []).filter((c) => {
      const opt = String(c.option || c.value || "").trim().toLowerCase();
      if (opt === "yes" || opt === "no") {
        // Keep real text answers that happen to be the words yes/no only when
        // kind is clearly free text. Yes/No button groups are kind "select".
        if (String(c.kind || "").toLowerCase() === "select") return false;
      }
      return true;
    });
    if (controls.length) out.push({ handle: r.handle, controls });
  }
  return out;
}

// Locate the Ashby Resume file control from extracted specs (before LLM).
function findAshbyResumeControl(specs) {
  for (const f of specs || []) {
    for (const c of f.controls || []) {
      if (!c || !c.is_file) continue;
      const label = c.label || f.label || "";
      if (inferFileRoleFromLabel(label) === "resume") {
        return { cid: c.cid, accept: c.accept || "", label };
      }
    }
  }
  return null;
}

async function uploadLeverResumeLast(tabId, pending) {
  if (!pending || !pending.file || tabId == null) return false;
  try {
    const res = await tabSend(tabId, { type: "AF_LV_UPLOAD_RESUME", file: pending.file });
    return !!(res && res.uploaded);
  } catch {
    return false;
  }
}

async function uploadWorkableResumeLast(tabId, pending) {
  if (!pending || !pending.file || tabId == null) return false;
  try {
    const res = await tabSend(tabId, { type: "AF_WB_UPLOAD_RESUME", file: pending.file });
    return !!(res && res.uploaded);
  } catch {
    return false;
  }
}

async function uploadBreezyResumeLast(tabId, pending) {
  if (!pending || !pending.file || tabId == null) return false;
  try {
    const res = await tabSend(tabId, { type: "AF_BZY_UPLOAD_RESUME", file: pending.file });
    return !!(res && res.uploaded);
  } catch {
    return false;
  }
}

async function uploadAshbyResumeLast(tabId, pending) {
  if (!pending || !pending.file || tabId == null) return false;
  try {
    const res = await tabSend(tabId, { type: "AF_ASHBY_UPLOAD_RESUME", file: pending.file });
    return !!(res && res.uploaded);
  } catch {
    return false;
  }
}

// Give the application tab OS focus so React commit-on-blur / focus handlers run
// (Workday-proven: side panel keeps document.hasFocus() false on the page).
async function focusApplicationTab(tabId) {
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* tab/window may be gone */
  }
  await delay(350);
}

// The autofill API validates each field block at <= MAX_CONTROLS_PER_FIELD (60)
// controls and <= MAX_AUTOFILL_FIELDS (40) blocks per request (see
// app/api/assistant_routes.py). A single dense container - e.g. a whole Jobvite
// application form, which is ONE <form> holding every field - can extract as one
// block with more controls than that cap, and the server then 422s the ENTIRE
// request ("List should have at most 60 items after validation, not 70"). Split
// any oversized block into sub-blocks (same html/label, sliced controls, distinct
// synthetic handles) and batch the blocks across requests. Every downstream step
// (file roles, needs_user, writes) keys off the globally-unique cid, never the
// handle, so the synthetic handles are transparent.
const AF_MAX_CONTROLS_PER_FIELD = 55; // safety margin below the server's 60
const AF_MAX_FIELDS_PER_REQUEST = 35; // safety margin below the server's 40

function chunkAutofillSpecs(apiSpecs) {
  const blocks = [];
  let synthHandle = 1_000_000; // well above the small real handles (0,1,2,...)
  for (const f of apiSpecs || []) {
    const controls = f.controls || [];
    if (controls.length <= AF_MAX_CONTROLS_PER_FIELD) {
      blocks.push(f);
      continue;
    }
    for (let i = 0; i < controls.length; i += AF_MAX_CONTROLS_PER_FIELD) {
      blocks.push({
        handle: i === 0 ? f.handle : synthHandle++,
        label: f.label,
        html: f.html,
        controls: controls.slice(i, i + AF_MAX_CONTROLS_PER_FIELD),
      });
    }
  }
  return blocks;
}

export async function autofillChunked(jobId, apiSpecs, prefs) {
  const blocks = chunkAutofillSpecs(apiSpecs);
  if (blocks.length <= AF_MAX_FIELDS_PER_REQUEST) {
    return await api.autofill(jobId, blocks, prefs);
  }
  // Too many blocks for one request: send in batches and merge the results.
  const merged = [];
  for (let i = 0; i < blocks.length; i += AF_MAX_FIELDS_PER_REQUEST) {
    const batch = blocks.slice(i, i + AF_MAX_FIELDS_PER_REQUEST);
    const resp = await api.autofill(jobId, batch, prefs);
    for (const r of (resp && resp.results) || []) merged.push(r);
  }
  return { results: merged };
}

// Send a write pass to the content script and wait until it reports completion
// (or a generous timeout). Awaiting completion lets us re-scan the DOM for
// fields that only render after a prior answer commits.
function writeAndWait(tabId, results, files) {
  return new Promise((resolve) => {
    const passId = ++writePassSeq;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      writeWaiter = null;
      resolve();
    };
    // Only the matching pass's completion resolves this wait, so the loop never
    // advances to the next extract on a stale/early signal from another pass.
    writeWaiter = { passId, finish };
    if (tabId != null) {
      try {
        tabSend(tabId, { type: "AF_WRITE", passId, results, files });
      } catch {
        /* ignore */
      }
    }
    // Poll-verify + retries per control can take a while on slow pages.
    setTimeout(finish, 25000);
  });
}

// Max fill -> re-scan -> fill-new cycles. Bounded so a field that can never be
// filled (needs_user) can't loop forever; a couple of passes covers the common
// "answer X reveals field Y" progressive forms (e.g. Hispanic=No reveals Race).
const AUTOFILL_MAX_PASSES = 4;
const SR_MAX_PAGES = 8; // SmartRecruiters multi-step applications: hard cap on steps
const BZY_MAX_PAGES = 6; // Breezy.hr multi-step applications: hard cap on sections
const JV_MAX_PAGES = 6; // Jobvite multi-step applications: hard cap on steps
const ICIMS_MAX_PAGES = 10; // iCIMS itineraries are typically 3-5 steps; cap well above

// Re-run auto-discovery on the current page and wait for the application
// container to register. Used between SmartRecruiters steps: after clicking
// "Next", the previous step's controls detach, so we re-select the (persistent
// or freshly mounted) form container to get live handles for the next step.
async function rediscoverForm(tabId) {
  setAutofill({ fields: [] });
  // Re-trigger discovery REPEATEDLY: the next step's <oc-oneclick-form> remounts
  // asynchronously and, on a slow network, often lands AFTER a single
  // AF_AUTOSELECT's internal retry window (~2.4s) expires. Re-sending every couple
  // seconds (for up to ~16s) guarantees a discovery pass fires once the step's
  // form is actually in the DOM, instead of giving up and ending the run.
  const deadline = Date.now() + 16000;
  let lastSend = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastSend > 2200) {
      lastSend = Date.now();
      try {
        await tabBroadcast(tabId, { type: "AF_AUTOSELECT" });
      } catch {
        /* ignore */
      }
    }
    if (state.autofill.fields.length) {
      await delay(400); // let the freshly mounted step settle before extracting
      return true;
    }
    await delay(200);
  }
  return state.autofill.fields.length > 0;
}

// Fill every control currently discovered on the page (one application step):
// platform prep -> multi-pass LLM fill -> controlled-form reconciliation.
// Labels and "needs your input" items accumulate into `ctx` across steps.
// Returns the last extracted specs (empty if nothing could be read).
async function fillCurrentPage(tabId, eng, ctx, isFirstPage) {
  // Greenhouse: ensure the form has a repeating education row for every entry
  // in the candidate's history before we extract + fill (Workday-style).
  if (eng && eng.platform === "greenhouse") {
    setAutofill({ runStatus: "Adding your education history…" });
    await prepareGreenhouseEducation(tabId);
  }
  if (eng && eng.platform === "applytojob") {
    setAutofill({ runStatus: "Preparing the resume upload…" });
    await prepareApplyToJob(tabId);
  }
  if (eng && eng.platform === "manatal") {
    setAutofill({ runStatus: "Accepting terms…" });
    await prepareManatal(tabId);
  }
  if (eng && eng.platform === "generic") {
    setAutofill({ runStatus: "Accepting terms…" });
    await prepareGeneric(tabId);
  }
  if (eng && eng.platform === "jobdiva") {
    setAutofill({ runStatus: "Opening Quick Apply…" });
    await prepareJobDiva(tabId);
  }
  // iCIMS: write the phone block and the "Create a login" block before
  // extraction so those fields already read as filled and never reach the model.
  if (eng && eng.platform === "icims") {
    setAutofill({ runStatus: "Filling your phone and portal login…" });
    await prepareIcims(tabId, ctx);
  }
  if (eng && eng.platform === "recruiterflow") {
    setAutofill({ runStatus: "Adding your work & education history…" });
    await prepareRecruiterFlow(tabId);
  }
  // SmartRecruiters: add + Save Experience/Education entries for whichever step
  // hosts those sections (a no-op on steps that don't, e.g. profiles/resume).
  if (eng && eng.platform === "smartrecruiters") {
    setAutofill({ runStatus: "Adding your work & education history…" });
    await prepareSmartRecruiters(tabId);
  }
  if (eng && eng.platform === "workable" && isFirstPage) {
    setAutofill({ runStatus: "Adding your work & education history…" });
    await prepareWorkable(tabId);
  }
  if (eng && eng.platform === "jobvite" && isFirstPage) {
    setAutofill({ runStatus: "Attaching your resume…" });
    await prepareJobvite(tabId);
  }
  // Replay remembered identity answers (EEO/work-auth/consent) before extract
  // so those controls are already filled and skip the harvest + LLM pass.
  if (eng && eng.mode === "select") {
    setAutofill({ runStatus: "Adding your cover letter…" });
    await prepareCoverLetter(tabId);
    setAutofill({ runStatus: "Filling your saved answers…" });
    await prepareCachedAnswers(tabId, eng.platform);
    // Commit browser-autofilled values into controlled React forms. Greenhouse
    // writes through dedicated drivers; commitPrefilled there only scans
    // comboboxes it must skip, so skip the call on Greenhouse only.
    if (eng.platform !== "greenhouse") {
      await commitPrefilled(tabId);
    }
  }
  const handles = state.autofill.fields.map((f) => f.handle);
  const attemptedKeys = new Set(); // stable control keys already sent to the LLM (this step)
  let lastSpecs = [];

  // Ashby renders the full application + EEO survey in one panel (no progressive
  // reveal that needs a second LLM pass). Extra passes re-open location
  // comboboxes (clearing them) and re-click Yes/No toggles (deselecting them).
  const maxPasses =
    eng && eng.platform === "pinpoint" ? 5 : eng && eng.platform === "ashby" ? 1 : AUTOFILL_MAX_PASSES;
  const passDelayMs = eng && eng.platform === "pinpoint" ? 750 : 500;
  const isLever = eng && eng.platform === "lever";
  const isWorkable = eng && eng.platform === "workable";
  const isBreezy = eng && eng.platform === "breezy";
  const isAshby = eng && eng.platform === "ashby";
  let leverResumePending = null;
  let workableResumePending = null;
  let breezyResumePending = null;
  let ashbyResumePending = null;
  let ashbyResumeUploadedEarly = false;

  for (let pass = 0; pass < maxPasses; pass++) {
    // Re-extract the live DOM each pass. Already-filled controls report
    // filled:true (and skip option harvesting); newly rendered controls show up.
    setAutofill({ runStatus: pass === 0 ? "Reading the application fields…" : "Checking for new fields…" });
    const specs = await extractSpecs(tabId, handles);
    const specControls = specs.reduce((n, s) => n + ((s.controls && s.controls.length) || 0), 0);
    if (!specs.length || !specControls) {
      if (pass === 0 && isFirstPage) {
        const onSurvey =
          eng &&
          eng.platform === "workable" &&
          state.autofill.fields.some((f) => /survey/i.test(f.label || ""));
        setAutofill({
          error: onSurvey
            ? "Could not read the survey questions. Reload the page and click Start autofill again."
            : "Could not read the selected fields. Try reselecting.",
        });
      }
      break;
    }
    lastSpecs = specs;

    // Only fill controls that are not already filled on the page and that we
    // have not already attempted in a prior pass (keyed by stable identity).
    const fresh = specs
      .map((f) => ({
        handle: f.handle,
        label: f.label,
        html: f.html || "",
        controls: (f.controls || []).filter((c) => !c.filled && !attemptedKeys.has(c.key)),
      }))
      .filter((f) => f.controls.length);
    if (!fresh.length) break;

    for (const f of fresh) {
      for (const c of f.controls) {
        attemptedKeys.add(c.key);
        ctx.labelByCid[c.cid] = c.label || f.label || "Field";
      }
    }

    // Strip client-only fields (key, filled) before sending to the LLM. The
    // 'html' snapshot carries each control's options inline (DOM-with-options).
    const apiSpecs = fresh.map((f) => ({
      handle: f.handle,
      label: f.label,
      html: f.html,
      controls: f.controls.map(({ key, filled, ...c }) => c),
    }));

    const freshCount = fresh.reduce((n, f) => n + f.controls.length, 0);
    setAutofill({ runStatus: `Choosing answers for ${freshCount} field${freshCount === 1 ? "" : "s"}…` });

    // Ashby: upload resume in parallel with the LLM round-trip. Parse finishes
    // while answers are generated, so we fill text/select fields ONCE afterward
    // and never need ashbyReapply (logs proved reapply was the 2nd write cycle:
    // write report 28 → write report 25 with no extract between).
    let ashbyEarlyResumePromise = null;
    if (isAshby && pass === 0 && !ashbyResumeUploadedEarly) {
      const resumeMeta = findAshbyResumeControl(specs);
      if (resumeMeta) {
        ashbyEarlyResumePromise = (async () => {
          try {
            const file = await fetchRoleFile(state.job.job_id, "resume", resumeMeta.accept, {});
            if (!file) {
              debugLog("[autofill] Ashby early resume: no file on server");
              return null;
            }
            setAutofill({ runStatus: "Uploading your resume…" });
            await focusApplicationTab(tabId);
            const ok = await uploadAshbyResumeLast(tabId, { cid: resumeMeta.cid, file });
            debugLog("[autofill] Ashby resume uploaded early (parallel with LLM):", !!ok);
            if (!ok) return null;
            markFileControlAttached(ctx, resumeMeta.cid);
            setAutofill({ runStatus: "Waiting for Ashby resume parse…" });
            await delay(1600);
            return { cid: resumeMeta.cid, file };
          } catch (err) {
            console.warn("[autofill] Ashby early resume failed:", err && err.message);
            return null;
          }
        })();
      }
    }

    const llmPromise = autofillChunked(state.job.job_id, apiSpecs, buildPreferences());
    const [resp, earlyResume] = await Promise.all([
      llmPromise,
      ashbyEarlyResumePromise || Promise.resolve(null),
    ]);
    if (earlyResume) ashbyResumeUploadedEarly = true;
    const results = (resp && resp.results) || [];

    try {
      console.groupCollapsed(`[autofill] pass ${pass}: sent specs -> LLM results`);
      debugLog("sent fields/controls:", JSON.parse(JSON.stringify(apiSpecs)));
      debugLog("LLM results:", JSON.parse(JSON.stringify(results)));
      console.groupEnd();
    } catch {}

    // Normalize file roles from labels when the model leaves them as "other"/empty,
    // then decide file needs_user from whether we can actually download the file,
    // never from the LLM's guess (it has no visibility into generated PDFs).
    normalizeFileRolesInResults(results, apiSpecs);

    for (const r of results) {
      for (const c of r.controls || []) {
        if (!c.needs_user) continue;
        // File controls are handled below via fetchFilesForResults.
        if (c.file_role === "resume" || c.file_role === "cover_letter") {
          c.needs_user = false;
          c.reason = null;
          continue;
        }
        const label = ctx.labelByCid[c.cid] || "Field";
        if (looksLikeResumeOrCoverLabel(label)) {
          c.needs_user = false;
          c.reason = null;
          continue;
        }
        ctx.needsUser.push({
          cid: c.cid,
          label,
          reason: c.reason || "Needs your input",
        });
      }
    }

    const { files, missing } = await fetchFilesForResults(state.job.job_id, results, apiSpecs);
    for (const m of missing) {
      const roleLabel = m.role === "cover_letter" ? "Cover letter" : "Resume";
      const why =
        m.role === "cover_letter"
          ? "no cover letter file was generated for this job (set up a cover letter template and build it)"
          : "no resume file was generated for this job yet";
      // Avoid duplicate rows if a prior pass already reported this cid.
      if (!ctx.needsUser.some((x) => x.cid === m.cid)) {
        ctx.needsUser.push({
          cid: m.cid,
          label: ctx.labelByCid[m.cid] || roleLabel,
          reason: `Upload manually - ${why}`,
        });
      }
    }
    if (missing.length) {
      try {
        console.warn("[autofill] missing generated files for upload:", missing);
      } catch {}
    }

    const writeCount = results.reduce((n, r) => n + (r.controls || []).length, 0);
    setAutofill({ runStatus: `Filling ${writeCount} field${writeCount === 1 ? "" : "s"} on the page…` });
    let writeResults = results;
    let writeFiles = files;
    if (isLever) {
      const split = splitLeverResumeWrite(results, files);
      writeResults = split.results;
      writeFiles = split.files;
      if (split.pending) leverResumePending = split.pending;
    }
    if (isWorkable) {
      const split = splitLeverResumeWrite(results, files);
      writeResults = split.results;
      writeFiles = split.files;
      if (split.pending) workableResumePending = split.pending;
    }
    if (isBreezy) {
      const split = splitLeverResumeWrite(results, files);
      writeResults = split.results;
      writeFiles = split.files;
      if (split.pending) breezyResumePending = split.pending;
    }
    // Ashby: resume is uploaded early (parallel with LLM). Strip it from the
    // write payload and do NOT schedule ashbyReapply, a second write was
    // re-opening comboboxes and leaving "What brought you" uncommitted.
    if (isAshby) {
      const split = splitLeverResumeWrite(results, files);
      writeResults = split.results;
      writeFiles = split.files;
      if (ashbyResumeUploadedEarly) {
        ashbyResumePending = null;
        ctx.ashbyReapply = null;
        debugLog("[autofill] Ashby: single write pass (resume already uploaded; no reapply)");
      } else if (split.pending) {
        // Fallback: early upload failed, defer resume + reapply (legacy path).
        ashbyResumePending = split.pending;
        ctx.ashbyReapply = stripAshbyToggleControls(writeResults);
        debugLog("[autofill] Ashby: early resume missed; falling back to upload-last + reapply");
      }
    }
    await writeAndWait(tabId, writeResults, writeFiles);

    // Drop false "needs you" rows for controls that actually filled/attached.
    if (ctx.needsUser.length) {
      const st = state.autofill.statuses || {};
      ctx.needsUser = ctx.needsUser.filter((item) => {
        const s = st[item.cid];
        return s !== "filled" && s !== "attached";
      });
    }

    // Remember stable identity answers (EEO/work-auth/consent) that actually
    // committed, so future jobs replay them without harvesting menus or
    // calling the LLM. Keyed by category; the exact chosen option text is
    // stored and fuzzy-matched on replay.
    const learned = {};
    for (const r of results) {
      for (const c of r.controls || []) {
        const cat = answerCategory(ctx.labelByCid[c.cid] || "");
        const ans = c.option || c.value;
        if (cat && ans && state.autofill.statuses[c.cid] === "filled") learned[cat] = String(ans);
      }
    }
    if (Object.keys(learned).length) {
      try {
        await storage.saveAnswerPairs(state.user && state.user.user_id, eng && eng.platform, learned);
      } catch {}
    }

    // Give conditionally rendered fields a moment to mount, then cheap-peek
    // for anything still unfilled. Avoids a full harvest extract when nothing
    // new appeared (Greenhouse: Hispanic→Race was the last reveal).
    if (pass + 1 >= maxPasses) break;
    await new Promise((r) => setTimeout(r, passDelayMs));
    let stillOpen = await countUnfilledControls(tabId, handles, attemptedKeys);
    // After the first write pass, progressive fields can mount slightly after
    // the settle delay, re-peek once before declaring the page done.
    if (!stillOpen && pass === 0) {
      await delay(250);
      stillOpen = await countUnfilledControls(tabId, handles, attemptedKeys);
    }
    if (!stillOpen) {
      try {
        debugLog("[autofill] no unfilled controls after pass", pass + 1, "- skipping further extracts");
      } catch {}
      break;
    }
  }

  // Final reconciliation for controlled forms (e.g. Ashby): a value can sit in
  // the DOM while the framework never recorded it - the early commit runs
  // before these fields are written, and the engine skips any control that
  // already holds a value, so a late/skipped write never fires React's
  // onChange and submit reports the field "missing". The browser also RE-applies
  // autofill to name/phone/company fields as focus moves during our writes, so a
  // value can appear after the last write. Let the page settle, then re-commit
  // every text field's CURRENT value through the React-safe path twice so a late
  // browser refill is still caught. It's idempotent (same text).
  // Final commit of text values into React/Apollo state. Ashby resume is
  // uploaded early (above); the legacy upload-last + reapply path runs only
  // when early upload failed.
  // Greenhouse: skip, drivers already commit via React-safe writes; the double
  // commit only re-scans comboboxes and adds ~600ms of idle delay.
  if (eng && eng.mode === "select" && eng.platform === "ashby") {
    setAutofill({ runStatus: "Finalizing the form…" });
    await focusApplicationTab(tabId);
    await delay(400);
    await commitPrefilled(tabId);
    await delay(200);
    await commitPrefilled(tabId);
  } else if (eng && eng.mode === "select" && eng.platform !== "greenhouse") {
    // Other select engines: one settle + commit (enough for browser autofill
    // without Greenhouse's empty combobox scan spam ×2).
    setAutofill({ runStatus: "Finalizing the form…" });
    await delay(250);
    await commitPrefilled(tabId);
  }
  if (eng && eng.platform === "ashby" && ashbyResumePending && !ashbyResumeUploadedEarly) {
    setAutofill({ runStatus: "Uploading your resume…" });
    await focusApplicationTab(tabId);
    const ok = await uploadAshbyResumeLast(tabId, ashbyResumePending);
    if (ok) {
      debugLog("[autofill] Ashby resume uploaded last (fallback after text commit)");
      markFileControlAttached(ctx, ashbyResumePending.cid);
      setAutofill({ runStatus: "Waiting for Ashby resume parse…" });
      await delay(1800);
      if (ctx.ashbyReapply && ctx.ashbyReapply.length) {
        debugLog("[autofill] Ashby reapply after fallback resume:", ctx.ashbyReapply);
        setAutofill({ runStatus: "Restoring fields after resume parse…" });
        await focusApplicationTab(tabId);
        await writeAndWait(tabId, ctx.ashbyReapply, {});
        await delay(300);
        await commitPrefilled(tabId);
        await delay(250);
        await commitPrefilled(tabId);
      } else {
        await commitPrefilled(tabId);
        await delay(250);
        await commitPrefilled(tabId);
      }
    }
  }
  if (eng && eng.platform === "smartrecruiters") {
    try {
      const ticked = await tabSend(tabId, { type: "AF_SR_TICK_CHECKBOXES" });
      if (ticked && ticked.ticked) {
        debugLog("[autofill] SR final checkbox sweep:", ticked.ticked);
      }
    } catch {
      /* ignore */
    }
  }
  if (eng && eng.platform === "pinpoint") {
    try {
      const ticked = await tabSend(tabId, { type: "AF_PP_TICK_CONSENT" });
      if (ticked && ticked.ticked) {
        debugLog("[autofill] Pinpoint consent ticked");
      }
    } catch {
      /* ignore */
    }
  }
  if (eng && eng.platform === "manatal") {
    try {
      const ticked = await tabSend(tabId, { type: "AF_MANATAL_PREP" });
      if (ticked && ticked.ticked) {
        debugLog("[autofill] Manatal consent ticked:", ticked.ticked);
      }
    } catch {
      /* ignore */
    }
  }
  if (eng && eng.platform === "jobvite") {
    // Satisfy Jobvite's unconditionally-required "describe" free-text fields (left
    // blank by the model when their paired Yes/No is negative) so "Next" is not
    // blocked. Runs after the model passes; only fills empty required text fields.
    try {
      const na = await tabSend(tabId, { type: "AF_JV_FILL_REQUIRED" });
      if (na && na.count) {
        debugLog("[autofill] Jobvite filled", na.count, "required text field(s) with N/A");
      }
    } catch {
      /* ignore */
    }
  }
  if (eng && eng.platform === "greenhouse") {
    // Satisfy Greenhouse's required free-text questions the model left empty
    // (open-ended availability / "describe" fields with no profile fact) so
    // "This field is required" does not block the submit. Runs after the model's
    // passes; only fills empty required <input type=text>/<textarea>.
    try {
      const na = await tabSend(tabId, { type: "AF_GH_FILL_REQUIRED" });
      if (na && na.count) {
        debugLog("[autofill] Greenhouse filled", na.count, "required text field(s) with N/A");
      }
    } catch {
      /* ignore */
    }
  }
  if (isLever) {
    if (leverResumePending) {
      setAutofill({ runStatus: "Uploading your resume…" });
      const ok = await uploadLeverResumeLast(tabId, leverResumePending);
      if (ok) {
        debugLog("[autofill] Lever resume uploaded last");
        markFileControlAttached(ctx, leverResumePending.cid);
        await delay(1200);
        await commitPrefilled(tabId);
      }
    }
  }
  if (isWorkable) {
    if (workableResumePending) {
      setAutofill({ runStatus: "Uploading your resume…" });
      const ok = await uploadWorkableResumeLast(tabId, workableResumePending);
      if (ok) {
        debugLog("[autofill] Workable resume uploaded last");
        markFileControlAttached(ctx, workableResumePending.cid);
        await delay(1200);
        await commitPrefilled(tabId);
      }
    }
  }
  if (isBreezy && breezyResumePending) {
    ctx.breezyResumePending = breezyResumePending;
  }

  return lastSpecs;
}

function markFileControlAttached(ctx, cid) {
  if (!cid) return;
  const statuses = { ...(state.autofill.statuses || {}), [cid]: "attached" };
  if (ctx && Array.isArray(ctx.needsUser)) {
    ctx.needsUser = ctx.needsUser.filter((item) => item.cid !== cid);
  }
  setAutofill({
    statuses,
    needsUser: ctx && Array.isArray(ctx.needsUser) ? ctx.needsUser : state.autofill.needsUser,
  });
}

export async function runAutofill() {
  if (!state.job || !state.autofill.fields.length || state.autofill.running) return;
  const tabId = state.autofill.tabId;
  // Clicking run leaves picking mode and clears the on-page selection outlines so
  // the page is clean while filling (control attributes are kept for the writer).
  if (tabId != null) {
    try {
      await tabBroadcast(tabId, { type: "AF_STOP" });
      await tabBroadcast(tabId, { type: "AF_HIDE_MARKS" });
    } catch {
      /* ignore */
    }
  }
  setAutofill({ running: true, runStatus: "Preparing the form…", error: null, statuses: {}, needsUser: [], picking: false });
  try {
    const eng = state.autofill.engine;
    const ctx = { labelByCid: {}, needsUser: [] };

    // Workable: after submit the application form is replaced by a survey on the
    // same tab - re-scan so we target survey-form instead of a detached handle.
    if (eng && eng.platform === "workable") {
      setAutofill({ runStatus: "Scanning the page…" });
      const ok = await rediscoverForm(tabId);
      if (!ok || !state.autofill.fields.length) {
        setAutofill({
          running: false,
          runStatus: null,
          error: "Could not find the application or survey form on this page.",
        });
        return;
      }
    }

    // iCIMS: EVERY step is a separate server-rendered document, so a handle
    // discovered on an earlier step is detached the moment the page moves on -
    // whether a previous run advanced it or the candidate clicked Submit
    // themselves. Extraction resolves handles through relocate(), which returns
    // null for a handle no element carries any more, so the run would read zero
    // controls and report "Could not read the selected fields" while sitting on a
    // perfectly fillable step. Re-discover against whatever step is actually open
    // so the run always starts from there.
    if (eng && eng.platform === "icims") {
      setAutofill({ runStatus: "Finding the current step…" });
      const found = await rediscoverForm(tabId);
      if (!found || !state.autofill.fields.length) {
        setAutofill({
          running: false,
          runStatus: null,
          error: "Could not find an iCIMS application form on this page.",
        });
        return;
      }
    }

    // JobDiva: ensure Quick Apply modal is open and re-discover .job-app-main
    // (may not have been mounted when Start was clicked).
    if (eng && eng.platform === "jobdiva") {
      setAutofill({ runStatus: "Opening Quick Apply…" });
      const prep = await prepareJobDiva(tabId);
      if (!prep.ready) {
        setAutofill({
          running: false,
          runStatus: null,
          error: "Could not open JobDiva Quick Apply on this page.",
        });
        return;
      }
      setAutofill({ runStatus: "Finding the application form…" });
      const found = await rediscoverForm(tabId);
      if (!found || !state.autofill.fields.length) {
        setAutofill({
          running: false,
          runStatus: null,
          error: "Could not find the JobDiva application form on this page.",
        });
        return;
      }
    }

    // iCIMS: the resume goes up FIRST. Attaching it submits the form and iCIMS
    // re-renders the profile pre-filled from the parsed resume, so any value
    // written beforehand would be thrown away. Re-discover afterwards: the
    // reload detached every handle we hold.
    if (eng && eng.platform === "icims") {
      const reloaded = await uploadIcimsResumeFirst(tabId, eng, ctx);
      if (reloaded) {
        setAutofill({ runStatus: "Re-reading the form after the resume upload…" });
        const ok = await rediscoverForm(tabId);
        if (!ok || !state.autofill.fields.length) {
          setAutofill({
            running: false,
            runStatus: null,
            error: "iCIMS reloaded after the resume upload but the profile form could not be found again. Click Start autofill once more.",
          });
          return;
        }
      }
    }

    let lastSpecs = await fillCurrentPage(tabId, eng, ctx, true);

    // SmartRecruiters: longer applications split across steps with a footer
    // "Next" button (the final step shows "Submit" instead). Fill the step, click
    // Next, re-discover the freshly rendered step, and fill again - repeating
    // until Next is gone or navigation is blocked. We never auto-submit.
    if (eng && eng.platform === "smartrecruiters" && lastSpecs.length) {
      for (let page = 1; page < SR_MAX_PAGES; page++) {
        setAutofill({ runStatus: "Moving to the next step…" });
        const nav = await tabSend(tabId, { type: "AF_SR_NEXT" });
        debugLog("[autofill] SR navigate result:", nav);
        if (!nav || !nav.advanced) {
          // Blocked by a required field we couldn't satisfy: tell the user which
          // ones so they can complete them and continue manually.
          if (nav && nav.blocked && Array.isArray(nav.errors) && nav.errors.length) {
            for (const lab of nav.errors) {
              ctx.needsUser.push({ cid: "sr-block:" + lab, label: lab, reason: "Complete this required field to continue to the next step" });
            }
          }
          break; // reached the Submit step, or navigation blocked
        }
        const ok = await rediscoverForm(tabId);
        if (!ok) break;
        lastSpecs = await fillCurrentPage(tabId, eng, ctx, false);
      }
    }

    // Workable: after the application form (or on a survey-only page), fill the
    // post-submit survey when it mounts. Re-discover so survey radios replace the
    // detached application handles. We never auto-submit the survey.
    if (eng && eng.platform === "workable") {
      for (let step = 0; step < 2; step++) {
        setAutofill({ runStatus: "Checking for survey questions…" });
        await delay(400);
        let hasSurvey = false;
        try {
          const probe = await tabSend(tabId, { type: "AF_WB_HAS_SURVEY" });
          hasSurvey = !!(probe && probe.survey);
        } catch {}
        if (!hasSurvey) break;
        const ok = await rediscoverForm(tabId);
        if (!ok) break;
        lastSpecs = await fillCurrentPage(tabId, eng, ctx, false);
      }
    }

    // iCIMS: the application spans a variable number of server-rendered steps
    // ("Candidate Profile -> Candidate Questions -> EEO -> Job Specific
    // Questions"), each a full POST that reloads the tab. The header lists the
    // whole itinerary up front (.iCIMS_Steps, "Step 2 of 4"), so we know BEFORE
    // clicking whether the next Submit is the final one.
    //
    // We advance through the middle steps automatically and deliberately stop on
    // the last one: that Submit files the application, which is the candidate's
    // call, matching every other engine here.
    //
    // Gated on lastSpecs like the loops above: fillCurrentPage assigns lastSpecs
    // as soon as extraction reads ANY control, before it filters out the ones
    // already filled - so a step that was fully pre-filled still reports specs,
    // and an empty result means the step could not be read at all. Submitting a
    // step we never read would post it blank.
    if (eng && eng.platform === "icims" && lastSpecs.length) {
      for (let page = 1; page < ICIMS_MAX_PAGES; page++) {
        const stage = await icimsStage(tabId);
        if (!stage) break; // no iCIMS form on this page - nothing left to drive
        if (!stage.hasSubmit) break;

        // Only ever click when the itinerary PROVES another step follows. An
        // absent indicator, or one that marks no step current (as the page after
        // the last step does), means we cannot tell - and a wrong guess files the
        // application. Hand over in every one of those cases.
        const positionKnown = stage.stepsPresent && stage.step > 0 && stage.total > 0;
        if (!positionKnown || stage.last) {
          ctx.needsUser.push({
            cid: "icims-submit",
            label: positionKnown
              ? `Final step (${stage.step} of ${stage.total}): ${stage.stepTitle || "Submit"}`
              : stage.stepTitle || "Submit this step",
            reason: positionKnown
              ? "Everything is filled. Review it and click Submit to send your application."
              : "Everything is filled. Review it and click Submit - this page doesn't say whether more steps follow.",
          });
          break;
        }

        setAutofill({
          runStatus: `Submitting step ${stage.step} of ${stage.total}…`,
        });
        const nav = await icimsAdvance(tabId, eng, stage);
        debugLog("[autofill] iCIMS advance:", nav);
        if (!nav.advanced) {
          // Rejected by the server: surface the field-level reasons it rendered.
          for (const msg of nav.errors || []) {
            ctx.needsUser.push({
              cid: "icims-block:" + msg,
              label: stage.stepTitle || `Step ${stage.step}`,
              reason: msg,
            });
          }
          if (!(nav.errors || []).length) {
            ctx.needsUser.push({
              cid: "icims-stuck",
              label: stage.stepTitle || `Step ${stage.step} of ${stage.total}`,
              reason: nav.timedOut
                ? "iCIMS did not finish loading the next step. Continue from the page as it stands."
                : "iCIMS would not accept this step. Check the highlighted fields and continue manually.",
            });
          }
          break;
        }

        setAutofill({
          runStatus: `Reading step ${nav.stage.step} of ${nav.stage.total}…`,
        });
        const ok = await rediscoverForm(tabId);
        if (!ok) {
          ctx.needsUser.push({
            cid: "icims-stuck",
            label: nav.stage.stepTitle || `Step ${nav.stage.step}`,
            reason: "The next step loaded but its form could not be read. Continue from the page as it stands.",
          });
          break;
        }
        lastSpecs = await fillCurrentPage(tabId, eng, ctx, false);
        if (!lastSpecs.length) {
          // The step loaded but nothing could be read from it - never submit a
          // step blind.
          ctx.needsUser.push({
            cid: "icims-unread",
            label: nav.stage.stepTitle || `Step ${nav.stage.step} of ${nav.stage.total}`,
            reason: "This step's fields could not be read. Complete it on the page and continue.",
          });
          break;
        }
      }
    }

    // Breezy: multi-step applications hide later sections behind Continue. Fill
    // the visible step, advance, re-discover, and fill again - never auto-submit.
    if (eng && eng.platform === "breezy" && lastSpecs.length) {
      for (let page = 1; page < BZY_MAX_PAGES; page++) {
        setAutofill({ runStatus: "Moving to the next step…" });
        const nav = await tabSend(tabId, { type: "AF_BZY_NEXT" });
        if (!nav || !nav.advanced) break;
        const ok = await rediscoverForm(tabId);
        if (!ok) break;
        lastSpecs = await fillCurrentPage(tabId, eng, ctx, false);
      }
    }

    // Jobvite: the application spans one or more steps behind a footer "Next"
    // button (the final step shows "Send Application" instead). Fill the visible
    // step, click Next, re-discover the freshly rendered step, and fill again -
    // stopping when Next is gone/blocked. We never auto-submit.
    if (eng && eng.platform === "jobvite" && lastSpecs.length) {
      for (let page = 1; page < JV_MAX_PAGES; page++) {
        setAutofill({ runStatus: "Moving to the next step…" });
        const nav = await tabSend(tabId, { type: "AF_JV_NEXT" });
        if (!nav || !nav.advanced) break;
        const ok = await rediscoverForm(tabId);
        if (!ok) break;
        lastSpecs = await fillCurrentPage(tabId, eng, ctx, false);
      }
    }

    if (eng && eng.platform === "breezy" && ctx.breezyResumePending) {
      setAutofill({ runStatus: "Uploading your resume…" });
      const ok = await uploadBreezyResumeLast(tabId, ctx.breezyResumePending);
      if (ok) {
        debugLog("[autofill] Breezy resume uploaded last");
        markFileControlAttached(ctx, ctx.breezyResumePending.cid);
        await delay(1200);
        await commitPrefilled(tabId);
      }
    }

    // Final sweep: never show a manual-review row for controls that attached/filled.
    const finalStatuses = state.autofill.statuses || {};
    ctx.needsUser = (ctx.needsUser || []).filter((item) => {
      const s = finalStatuses[item.cid];
      return s !== "filled" && s !== "attached";
    });

    // JobDiva: auto-submit then Complete & Next. Other engines never auto-submit;
    // JobDiva Quick Apply is intentionally one-shot. Do this while running is
    // still true so submit-watch's APP_SUBMITTED cannot race completeJob.
    if (eng && eng.platform === "jobdiva" && lastSpecs.length) {
      if (ctx.needsUser && ctx.needsUser.length) {
        setAutofill({ running: false, runStatus: null, specs: lastSpecs, needsUser: ctx.needsUser });
        return;
      }
      setAutofill({ runStatus: "Submitting your application…" });
      const sub = await submitJobDiva(tabId);
      debugLog("[autofill] JobDiva submit result:", sub);
      if (sub.submitted) {
        setAutofill({ running: false, runStatus: null, specs: lastSpecs, needsUser: [] });
        toast("Application submitted, completing & loading next…");
        await completeJob({ next: true });
        return;
      }
      if (sub.errors && sub.errors.length) {
        for (const lab of sub.errors) {
          ctx.needsUser.push({
            cid: "jd-block:" + lab,
            label: lab,
            reason: "Complete this required field to submit",
          });
        }
      } else if (!sub.clicked) {
        ctx.needsUser.push({
          cid: "jd-submit",
          label: "Submit Application",
          reason: "Could not find or click Submit Application. Submit on the page, then Complete & Next.",
        });
      } else {
        ctx.needsUser.push({
          cid: "jd-submit-pending",
          label: "Submit Application",
          reason: "Submit was clicked but confirmation was not detected. Check the page, then Complete & Next if it succeeded.",
        });
      }
    }

    setAutofill({ running: false, runStatus: null, specs: lastSpecs, needsUser: ctx.needsUser });
  } catch (err) {
    setAutofill({ running: false, runStatus: null, error: (err && err.message) || "Autofill failed." });
  }
}

// Prefer the frame that actually hosts the application (Greenhouse embeds win).
function scoreAutofillField(field) {
  let score = (field.controlCount || 0) * 10;
  const url = (field.frameUrl || "").toLowerCase();
  if (/greenhouse\.io/.test(url) && /embed\/job_app/.test(url)) score += 1000;
  else if (/greenhouse\.io/.test(url) && /\/jobs\//.test(url)) score += 900;
  else if (/greenhouse\.io/.test(url)) score += 500;
  if ((field.controlCount || 0) > 0) score += 50;
  return score;
}

/** Messages from the picker / writer content scripts. Returns true when handled. */
export function handleFormMessage(msg, sender) {
  if (msg.type === "AF_FIELDS") {
    if (!extractCollector) return true;
    for (const f of msg.fields || []) extractCollector.collected.set(f.handle, f);
    for (const h of extractCollector.expected) {
      if (!extractCollector.collected.has(h)) return true;
    }
    extractCollector.finish();
    return true;
  }
  if (!msg.type.startsWith("AF_")) return false;
  const af = state.autofill;
  if (!af.active) return true;

  if (msg.type === "AF_FIELD_ADDED") {
    const frameId = sender && sender.frameId != null ? sender.frameId : 0;
    const field = {
      handle: msg.handle,
      label: msg.label || "Field",
      level: msg.level || "valid",
      controlCount: msg.controlCount || 1,
      frameId,
      frameUrl: msg.frameUrl || (sender && sender.url) || "",
    };
    field._score = scoreAutofillField(field);
    if (af.discovering || (af.engine && af.engine.autoDiscover)) {
      const cur = af.fields[0];
      if (!cur || field._score >= (cur._score != null ? cur._score : -1)) {
        setAutofill({ fields: [field], primaryFrameId: frameId });
      }
      return true;
    }
    const idx = af.fields.findIndex((f) => f.handle === msg.handle);
    if (idx >= 0) {
      const fields = af.fields.slice();
      fields[idx] = { ...fields[idx], ...field };
      setAutofill({ fields, primaryFrameId: frameId });
    } else {
      setAutofill({
        fields: [...af.fields, field],
        primaryFrameId: af.primaryFrameId != null ? af.primaryFrameId : frameId,
      });
    }
  } else if (msg.type === "AF_WRITE_RESULT") {
    const statuses = { ...af.statuses };
    for (const r of msg.report || []) statuses[r.cid] = r.status;
    setAutofill({ statuses });
    if (writeWaiter && (msg.passId == null || msg.passId === writeWaiter.passId)) writeWaiter.finish();
  } else if (msg.type === "AF_AUTOSELECT_DONE") {
    // AF_FIELD_ADDED from the same frame arrives first, so the form is registered.
    if (af.discovering && msg.count) maybeAutoRun();
  } else if (msg.type === "AF_PICKING_STOPPED") {
    if (af.picking) setAutofill({ picking: false });
  }
  return true;
}

/** Aggregate per-control statuses into one status for a discovered form block. */
export function blockStatus(af, handle) {
  const spec = (af.specs || []).find((s) => s.handle === handle);
  if (!spec) return null;
  const got = (spec.controls || []).map((c) => af.statuses[c.cid]).filter(Boolean);
  if (!got.length) return null;
  if (got.some((s) => s === "filled" || s === "attached")) {
    return got.some((s) => s === "needs_user" || s === "skipped" || s === "not_found") ? "partial" : "filled";
  }
  if (got.every((s) => s === "needs_user")) return "needs_user";
  if (got.some((s) => s === "not_found")) return "not_found";
  return "skipped";
}
