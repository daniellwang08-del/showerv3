// One application: open, documents, analysis, chat, complete and next,
// report, Pumble, the ask hotkey, and submit detection.

import * as api from "../../api.js";
import { autofillPermissionOrigins, resolveEngine } from "../../engines.js";
import { teardownAutofill } from "../autofill/index.js";
import { localTimezone, messageOf, toJobCard } from "../format.js";
import { LISTS, listQuery } from "../lists.js";
import { live } from "../live.js";
import { setState, state } from "../state.js";
import { getWebWorkTab, openInWorkTab } from "../tabs.js";
import { toast } from "../toast.js";
import { goHome } from "./home.js";

const ADVANCE_COOLDOWN_MS = 12_000;
const SUBMIT_REPEAT_MS = 8_000;
const PENDING_SUBMIT_MAX_AGE_MS = 45_000;
const PENDING_ASK_MAX_AGE_MS = 30_000;

// ── open ────────────────────────────────────────────────────────────────────

let openSeq = 0;

function docsFrom(raw) {
  const d = raw || {};
  return {
    resumePdf: !!d.resume_pdf,
    resumeDocx: !!d.resume_docx,
    coverPdf: !!d.cover_pdf,
    coverDocx: !!d.cover_docx,
    contentStatus: d.content_status || null,
    buildError: d.build_error || null,
  };
}

function jobFromSession(s) {
  const snap = s.job_snapshot || {};
  return {
    job_id: String(s.job_id),
    url: snap.url || s.job_url || "",
    title: snap.title || s.job_title || "Untitled role",
    company: snap.company || s.company || "",
    location: snap.location || "",
    score: snap.match_score != null ? Math.round(Number(snap.match_score)) : null,
    snapshot: snap,
    ready: !!snap.ready,
    applied: !!s.applied_at,
    appliedAt: s.applied_at || null,
    pumblePosted: !!s.pumble_posted,
    docs: docsFrom(s.docs),
    analyzing: false,
  };
}

/**
 * Open a job in the panel. `navigate` loads its posting in the work tab.
 * `context` is the list it came from, used by "Applied, next job".
 */
export async function openJob(jobId, { navigate = false, context, keepReportNotice = false } = {}) {
  const id = String(jobId);
  const seq = ++openSeq;
  stopStreaming();
  if (state.job && state.job.job_id !== id) await teardownAutofill().catch(() => {});
  setState({
    view: "job",
    job: null,
    jobError: null,
    chat: { messages: [], streaming: false },
    ...(context !== undefined ? { applyContext: context } : {}),
    ...(keepReportNotice ? {} : { reportNotice: null }),
  });
  try {
    const session = await api.openSession(id, { fresh: true });
    if (seq !== openSeq) return;
    const job = jobFromSession(session);
    job.engine = resolveEngine({ snapshot: job.snapshot });
    if (navigate && job.url) await openInWorkTab(job.url);
    if (seq !== openSeq) return;
    setState({ job });
    markSeen(id);
    chrome.storage.session.set({ activeApplyJobId: id }).catch(() => {});
    void armAskHotkey({ requestPermission: true, jobUrl: job.url });
    if (navigate) setTimeout(() => void armAskHotkey({ requestPermission: false, jobUrl: job.url }), 1800);
    void consumePendingAskSelection();
    // After Complete & Next, a submit stash from the previous job must not
    // complete this one.
    if (!navigate) void consumePendingAppSubmitted();
    watchJob(id);
  } catch (err) {
    if (seq !== openSeq) return;
    setState({ jobError: messageOf(err, "Could not open this job.") });
  }
}

/** Open from a list row; Complete & Next then walks the same list. */
export function openFromList(jobId) {
  const listId = state.listId;
  const def = LISTS[listId];
  const items = state.list.items || [];
  const context = def
    ? {
        listId,
        title: def.title,
        query: listQuery(listId, state.filters, state.list.page || 1, state.pageSize, localTimezone()),
        ids: items.map((j) => String(j.id)),
        page: state.list.page || 1,
        pages: state.list.pages || 1,
        seen: [],
      }
    : null;
  return openJob(jobId, { navigate: true, context });
}

/** Open from the in-progress list; next walks the remaining sessions. */
export function openFromSessions(jobId, ids) {
  return openJob(jobId, {
    navigate: true,
    context: { listId: "progress", title: "In progress", query: null, ids: ids.map(String), page: 1, pages: 1, seen: [] },
  });
}

function markSeen(jobId) {
  const ctx = state.applyContext;
  if (!ctx || ctx.seen.includes(jobId)) return;
  setState({ applyContext: { ...ctx, seen: [...ctx.seen, jobId] } });
}

function patchJob(jobId, patch) {
  if (!state.job || state.job.job_id !== jobId) return;
  setState({ job: { ...state.job, ...(typeof patch === "function" ? patch(state.job) : patch) } });
}

// ── documents and analysis refresh ──────────────────────────────────────────

let watchTimer = null;

function docsComplete(d) {
  return (d.resumePdf || d.resumeDocx) && (d.coverPdf || d.coverDocx);
}

function docsBuilding(d) {
  return ["queued", "pending", "processing", "running", "generating"].includes(String(d.contentStatus || "").toLowerCase());
}

/**
 * Live events refresh documents and the analysis as they finish. Only when
 * the live connection is down does this fall back to slow polling.
 */
function watchJob(jobId, attempt = 0) {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
  const job = state.job;
  if (!job || job.job_id !== jobId || attempt > 40) return;
  const waiting = job.analyzing || (!docsComplete(job.docs) && docsBuilding(job.docs));
  if (!waiting) return;
  watchTimer = setTimeout(async () => {
    if (live.status !== "online") {
      if (state.job && state.job.analyzing) await refreshSnapshot(jobId);
      else await refreshDocs(jobId);
    }
    watchJob(jobId, attempt + 1);
  }, 6000);
}

export async function refreshDocs(jobId = state.job && state.job.job_id) {
  if (!jobId) return;
  try {
    const docs = docsFrom(await api.getSessionDocs(jobId));
    patchJob(jobId, { docs });
  } catch {
    /* next event or poll retries */
  }
}

export async function refreshSnapshot(jobId = state.job && state.job.job_id) {
  if (!jobId) return;
  try {
    const session = await api.openSession(jobId, { fresh: false });
    const next = jobFromSession(session);
    patchJob(jobId, (job) => ({
      snapshot: next.snapshot,
      ready: next.ready,
      score: next.score,
      title: next.title,
      company: next.company,
      location: next.location,
      docs: next.docs,
      analyzing: job.analyzing && !next.ready,
    }));
  } catch {
    /* next event or poll retries */
  }
}

/** Live event for a job: refresh only what changed. */
export function onJobEvent(type, jobId) {
  if (!state.job || state.job.job_id !== String(jobId)) return;
  if (type.startsWith("match_") || type === "extraction_completed") void refreshSnapshot(jobId);
  else void refreshDocs(jobId);
}

export async function runAnalysis() {
  const job = state.job;
  if (!job || job.analyzing) return;
  try {
    await api.triggerMatch(job.job_id);
    patchJob(job.job_id, { analyzing: true });
    toast("Analyzing this job. It usually takes under a minute.");
    watchJob(job.job_id);
  } catch (err) {
    toast(messageOf(err, "Could not start the analysis."), "danger");
  }
}

export async function downloadDoc(fileTypes, label) {
  const job = state.job;
  if (!job) return;
  let lastErr = null;
  for (const fileType of [].concat(fileTypes).filter(Boolean)) {
    try {
      const file = await api.downloadResumeFile(job.job_id, fileType);
      const binary = atob(file.base64 || "");
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mime || "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename || `${label.replace(/\s+/g, "_")}.${fileType.endsWith("docx") ? "docx" : "pdf"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`${label} downloaded.`, "ok");
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  toast(messageOf(lastErr, `Could not download the ${label.toLowerCase()}.`), "danger");
}

// ── chat ────────────────────────────────────────────────────────────────────

let chatAbort = null;

export async function ask(question) {
  const job = state.job;
  const text = String(question || "").trim();
  if (!job || !text || state.chat.streaming) return;
  const ctrl = new AbortController();
  chatAbort = ctrl;
  const messages = [...state.chat.messages, { role: "user", content: text }, { role: "assistant", content: "", streaming: true }];
  setState({ chat: { messages, streaming: true } });
  const updateLast = (fn) => {
    if (chatAbort !== ctrl) return;
    const list = state.chat.messages.slice();
    list[list.length - 1] = fn(list[list.length - 1]);
    setState({ chat: { ...state.chat, messages: list } });
  };
  try {
    await api.chatStream(
      { job_id: job.job_id, message: text, style: state.chatStyle, field_type: state.answerType || null },
      { signal: ctrl.signal, onDelta: (d) => updateLast((m) => ({ ...m, content: m.content + d })) },
    );
    updateLast((m) => ({ ...m, streaming: false }));
  } catch (err) {
    if (ctrl.signal.aborted) {
      updateLast((m) => ({ ...m, streaming: false, stopped: true }));
    } else {
      updateLast((m) => ({ ...m, streaming: false, error: messageOf(err, "The assistant could not answer.") }));
    }
  } finally {
    if (chatAbort === ctrl) {
      chatAbort = null;
      setState({ chat: { ...state.chat, streaming: false } });
    }
  }
}

export function stopStreaming() {
  if (chatAbort) chatAbort.abort();
}

// ── complete and next ───────────────────────────────────────────────────────

// Outlives one completeJob call so submit detection, a stored submit, and a
// click cannot complete the freshly opened next job right after advancing.
let completeInFlight = false;
let completingJobId = null;
let lastAdvanceAt = 0;
let autoCompleting = false;
let lastAutoJobId = null;
let lastAutoAt = 0;

async function resolveNext(afterId) {
  const ctx = state.applyContext;
  const skip = new Set([afterId, ...(ctx ? ctx.seen : [])]);
  if (!ctx) {
    const nx = await api.nextJob(afterId, { view: "ready", timezone: localTimezone() });
    return nx && nx.job_id ? { jobId: String(nx.job_id) } : null;
  }
  const idx = ctx.ids.indexOf(afterId);
  const tail = idx >= 0 ? ctx.ids.slice(idx + 1) : ctx.ids;
  const local = tail.find((id) => !skip.has(id));
  if (local) return { jobId: local };
  if (!ctx.query) return null;
  // Applied jobs drop out of some lists, so re-read from the current page.
  for (let page = ctx.page; page <= Math.min(ctx.pages + 1, ctx.page + 3); page++) {
    const data = await api.getJobs({ ...ctx.query, page });
    const rows = (data.items || []).map(toJobCard);
    const hit = rows.find((j) => !skip.has(j.id) && !j.applied);
    if (hit) {
      return { jobId: hit.id, ctx: { ...ctx, ids: rows.map((j) => j.id), page, pages: data.pages || ctx.pages } };
    }
    if (page >= (data.pages || 1)) break;
  }
  return null;
}

async function advance(fromJobId, { keepReportNotice = false } = {}) {
  const title = (state.applyContext && state.applyContext.title) || "Ready to apply";
  const next = await resolveNext(fromJobId);
  if (next) {
    if (next.ctx) setState({ applyContext: next.ctx });
    await openJob(next.jobId, { navigate: true, keepReportNotice });
    return;
  }
  toast(`That was the last job in ${title}.`, "ok");
  await goHome();
}

/** Mark the open job applied. With `next`, open the next job in its list. */
export async function completeJob({ next }) {
  if (!state.job) return;
  const jobId = state.job.job_id;
  if (completeInFlight || completingJobId === jobId) return;
  completeInFlight = true;
  completingJobId = jobId;
  let advanced = false;
  try {
    chrome.storage.session.remove("pendingAppSubmitted").catch(() => {});
    await teardownAutofill();
    try {
      const marked = await api.markApplied([jobId]);
      if (!marked || !(Number(marked.marked) > 0)) throw new Error("Could not mark this job as applied. Try again.");
      api.updateSession(jobId, "completed").catch(() => {});
      patchJob(jobId, { applied: true, appliedAt: marked.applied_at || new Date().toISOString() });
    } catch (err) {
      toast(messageOf(err, "Could not mark this job as applied."), "danger");
      return;
    }
    if (!next) {
      window.close();
      return;
    }
    try {
      await advance(jobId);
      advanced = true;
    } catch (err) {
      toast(messageOf(err, "Could not load the next job."), "danger");
    }
  } finally {
    if (next && advanced) {
      lastAdvanceAt = Date.now();
      lastAutoJobId = jobId;
      lastAutoAt = lastAdvanceAt;
      setTimeout(() => {
        if (completingJobId === jobId) {
          completeInFlight = false;
          completingJobId = null;
        }
      }, ADVANCE_COOLDOWN_MS);
    } else {
      completeInFlight = false;
      completingJobId = null;
    }
  }
}

/** The application page reported a submit: same as "Applied, next job". */
export async function handleApplicationSubmitted(msg) {
  chrome.storage.session.remove("pendingAppSubmitted").catch(() => {});
  if (completeInFlight || autoCompleting) return;
  // Multi-step forms submit intermediate steps during a fill run.
  if (state.autofill && state.autofill.running) return;
  const now = Date.now();
  if (lastAdvanceAt && now - lastAdvanceAt < ADVANCE_COOLDOWN_MS) return;
  if (state.view !== "job" || !state.job || state.job.applied) return;
  const jobId = state.job.job_id;
  const msgJobId = msg && msg.jobId != null ? String(msg.jobId) : "";
  if (msgJobId && msgJobId !== jobId) return;
  if (lastAutoJobId === jobId && now - lastAutoAt < SUBMIT_REPEAT_MS) return;
  lastAutoJobId = jobId;
  lastAutoAt = now;
  autoCompleting = true;
  try {
    toast("Application submitted. Opening the next job.", "ok");
    await completeJob({ next: true });
  } finally {
    autoCompleting = false;
  }
}

async function consumePendingAppSubmitted() {
  try {
    const { pendingAppSubmitted: pending } = await chrome.storage.session.get("pendingAppSubmitted");
    if (!pending || !pending.at) return;
    const stale =
      Date.now() - Number(pending.at) > PENDING_SUBMIT_MAX_AGE_MS ||
      completeInFlight ||
      (lastAdvanceAt && Date.now() - lastAdvanceAt < ADVANCE_COOLDOWN_MS);
    if (stale) {
      await chrome.storage.session.remove("pendingAppSubmitted");
      return;
    }
    await handleApplicationSubmitted(pending);
  } catch {
    /* session storage unavailable */
  }
}

// ── report and Pumble ───────────────────────────────────────────────────────

export function reportExpired() {
  const job = state.job;
  if (!job) return;
  setState({
    modal: {
      title: "Report this posting as expired?",
      message: "It will be removed from your lists and the next job opens. This cannot be undone.",
      confirmLabel: "Report expired",
      tone: "danger",
      busy: false,
      onConfirm: () => confirmReport(job),
    },
  });
}

async function confirmReport(job) {
  setState({ modal: { ...state.modal, busy: true } });
  try {
    await api.reportJobInvalid(job.job_id, "expired");
    api.updateSession(job.job_id, "completed").catch(() => {});
  } catch (err) {
    setState({ modal: null });
    toast(messageOf(err, "Could not report this job."), "danger");
    return;
  }
  await teardownAutofill();
  setState({ modal: null, reportNotice: { title: job.title, company: job.company } });
  try {
    await advance(job.job_id, { keepReportNotice: true });
  } catch {
    await goHome();
  }
}

export function dismissReportNotice() {
  setState({ reportNotice: null });
}

export async function postToPumble(jobIds) {
  const ids = [...new Set((jobIds || []).map(String).filter(Boolean))];
  if (!ids.length || state.postingToPumble) return;
  const home = state.home.data;
  if (home && !home.pumble_configured) {
    toast("Connect Pumble in NAO Settings first.", "warn");
    return;
  }
  setState({ postingToPumble: true });
  try {
    const data = await api.postJobsToPumble(ids);
    const posted = data.posted_count || 0;
    const skipped = data.skipped_already_in_thread || 0;
    const failed = data.failed_count || 0;
    const parts = [];
    if (posted) parts.push(`Posted ${posted === 1 ? "to Pumble" : `${posted} jobs to Pumble`}`);
    if (skipped) parts.push(`${skipped} already in today's thread`);
    if (failed) parts.push(`${failed} failed`);
    toast(parts.length ? `${parts.join(", ")}.` : "Nothing was posted.", failed ? "warn" : "ok");
    if (posted && state.job && ids.includes(state.job.job_id)) patchJob(state.job.job_id, { pumblePosted: true });
  } catch (err) {
    toast(messageOf(err, "Could not post to Pumble."), "danger");
  } finally {
    setState({ postingToPumble: false });
  }
}

// ── ask hotkey ──────────────────────────────────────────────────────────────

/** Inject the selection hotkey into the application tab (and its ATS frames). */
export async function armAskHotkey({ requestPermission = false, jobUrl = null } = {}) {
  try {
    const tab = await getWebWorkTab();
    const tabUrl = (tab && tab.url) || "";
    const httpUrl = [tabUrl, jobUrl].find((u) => /^https?:\/\//i.test(u || "")) || "";
    if (!httpUrl) return;
    const engine = resolveEngine({ snapshot: state.job && state.job.snapshot, pageUrl: httpUrl });
    const origins = autofillPermissionOrigins(httpUrl, engine && engine.platform);
    if (!origins.length) return;
    if (!(await chrome.permissions.contains({ origins }))) {
      if (!requestPermission) return;
      if (!(await chrome.permissions.request({ origins }))) {
        toast("Allow page access so the ask hotkey can read your selection.", "warn");
        return;
      }
    }
    await chrome.storage.session.set({ askHotkeyArmed: true });
    if (tab && tab.id != null && /^https?:/i.test(tabUrl)) {
      await chrome.runtime.sendMessage({ type: "ASK_HOTKEY_INJECT", tabId: tab.id });
    }
  } catch {
    /* permissions prompt needs a user gesture; the next open retries */
  }
}

let lastAskAt = 0;

export async function handleAskSelection(msg) {
  const now = Date.now();
  if (now - lastAskAt < 400) return;
  lastAskAt = now;
  chrome.storage.session.remove("pendingAskSelection").catch(() => {});
  const text = String((msg && msg.text) || "").trim();
  if (!text || (msg && msg.empty)) {
    toast("Select the question on the page, then press the hotkey.");
    return;
  }
  if (!state.user) return toast("Sign in to ask the assistant.");
  if (state.view !== "job" || !state.job) return toast("Open a job first, then use the hotkey.");
  if (state.chat.streaming) return toast("Wait for the current answer to finish.");
  await ask(text);
}

async function consumePendingAskSelection() {
  try {
    const { pendingAskSelection: pending } = await chrome.storage.session.get("pendingAskSelection");
    if (!pending || !pending.at) return;
    if (Date.now() - Number(pending.at) > PENDING_ASK_MAX_AGE_MS) {
      await chrome.storage.session.remove("pendingAskSelection");
      return;
    }
    await handleAskSelection(pending);
  } catch {
    /* session storage unavailable */
  }
}

// ── handoffs from the web app ───────────────────────────────────────────────

/** "Apply with assistant" on the dashboard stores a job for the panel. */
export async function consumePendingWebappJob() {
  if (!state.user) return;
  try {
    const { pendingWebappJob: pending } = await chrome.storage.session.get("pendingWebappJob");
    if (!pending || !pending.jobId) return;
    await chrome.storage.session.remove("pendingWebappJob");
    await openJob(String(pending.jobId), { context: null });
  } catch {
    /* session storage unavailable */
  }
}

export async function consumePendingHandoffs() {
  await consumePendingWebappJob();
}

export function onWebappOpenJob(jobId) {
  if (!state.user) return;
  chrome.storage.session.remove("pendingWebappJob").catch(() => {});
  void openJob(String(jobId), { context: null });
}
