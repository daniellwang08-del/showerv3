// One unattended application. The console loads this page in a hidden iframe
// per job, so every run gets its own copy of the panel state and autofill
// modules: parallel runs cannot see each other's fields or messages.
//
// Flow: open the job in a background tab -> fill it with the platform engine ->
// check the page -> submit (unless dry run) -> answer an emailed code when the
// ATS asks for one -> confirm -> mark applied. Anything it cannot finish is
// left open in its tab for the user.

import * as api from "../api.js";
import * as storage from "../storage.js";
import { detectPlatform, resolveEngine } from "../engines.js";
import { docsComplete, jobFromSession } from "../panel/actions/job.js";
import { handleAutofillMessage, startAutofill } from "../panel/autofill/index.js";
import { setFocusGate } from "../panel/autofill/shared.js";
import { emptyAutofill, setState, state } from "../panel/state.js";
import { AGGREGATOR_HOSTS, NEEDS_ACCOUNT, applyPageUrl, hostOf } from "./platforms.js";

const AA_TAB_PREFIX = "aaTab:";
const LOAD_TIMEOUT_MS = 45_000;
const FILL_TIMEOUT_MS = 8 * 60_000;
const CONFIRM_TIMEOUT_MS = 75_000;
const OTP_TIMEOUT_MS = 4 * 60_000;
const OTP_POLL_MS = 8_000;

const console_ = window.parent && window.parent.naoAutoApply;
const params = new URLSearchParams(location.search);
const jobId = params.get("job");

let submittedSignal = null;
let ownTabId = null;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function report(patch) {
  if (console_) console_.update(jobId, patch);
}

function step(message) {
  report({ message });
}

class Stop extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const needsYou = (message, extra) => new Stop("needs_you", message, extra);
const skipped = (message) => new Stop("skipped", message);

// ── page helpers (content/auto-apply.js) ────────────────────────────────────

async function injectHelpers(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content/auto-apply.js"] });
  } catch {
    /* frames without host access are skipped */
  }
}

async function pageCall(tabId, op, arg = null, frameId = null) {
  try {
    const results = await chrome.scripting.executeScript({
      target: frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true },
      func: (name, value) => {
        const aa = window.__NAO_AA__;
        return aa && typeof aa[name] === "function" ? aa[name](value) : null;
      },
      args: [op, arg],
    });
    return (results || []).filter((r) => r && r.result).map((r) => ({ frameId: r.frameId, ...r.result }));
  } catch {
    return [];
  }
}

/** One view of the page across frames (embedded ATS forms live in iframes). */
async function pageState(tabId) {
  await injectHelpers(tabId);
  const frames = await pageCall(tabId, "state");
  const pick = (fn) => frames.find(fn) || null;
  const submitFrame = pick((f) => f.submit && !f.submit.disabled && f.formish) || pick((f) => f.submit);
  const otpFrame = pick((f) => f.otp);
  return {
    frames: frames.length,
    url: (pick((f) => f.top) || {}).url || "",
    confirmed: frames.some((f) => f.confirmed),
    submit: submitFrame ? { ...submitFrame.submit, frameId: submitFrame.frameId } : null,
    next: (pick((f) => f.next) || {}).next || null,
    otp: otpFrame ? { ...otpFrame.otp, frameId: otpFrame.frameId } : null,
    captcha: frames.some((f) => f.captcha),
    captchaWidget: frames.some((f) => f.captchaWidget),
    errors: frames.flatMap((f) => f.errors || []).slice(0, 6),
    missing: frames.flatMap((f) => f.missing || []).slice(0, 8),
  };
}

// ── tab ─────────────────────────────────────────────────────────────────────

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(ok);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t && t.status === "complete") finish(true);
      })
      .catch(() => finish(false));
  });
}

async function openTab(url, windowId) {
  const tab = await chrome.tabs.create({ url, active: false, ...(windowId != null ? { windowId } : {}) });
  ownTabId = tab.id;
  await chrome.storage.session.set({ [AA_TAB_PREFIX + tab.id]: { jobId, at: Date.now() } });
  report({ tabId: tab.id });
  await waitForLoad(tab.id, LOAD_TIMEOUT_MS);
  // Client-rendered ATS pages mount the form after "complete".
  await delay(2500);
  return chrome.tabs.get(tab.id);
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await delay(300);
  await waitForLoad(tabId, LOAD_TIMEOUT_MS);
  await delay(2500);
  return chrome.tabs.get(tabId);
}

// ── fill ────────────────────────────────────────────────────────────────────

async function waitForFill() {
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < FILL_TIMEOUT_MS) {
    const af = state.autofill;
    if (af.runStatus && af.runStatus !== lastStatus) {
      lastStatus = af.runStatus;
      step(af.runStatus);
    }
    if (af.runDone && !af.running) return af;
    if (af.error && !af.discovering && !af.running) return af;
    await delay(500);
  }
  throw needsYou("Filling took too long. Finish the form on the page.");
}

async function fill(tab) {
  setState({ autofill: emptyAutofill() });
  const res = await startAutofill({ tab, headless: true });
  if (!res || !res.ok) throw needsYou((res && res.error) || "Autofill could not start on this page.");
  const af = await waitForFill();
  if (af.error) throw needsYou(af.error);
  const needs = (af.needsUser || []).map((n) => `${n.label}: ${n.reason}`);
  return { filled: (af.specs || []).length, needs };
}

// ── submit, confirm, code ───────────────────────────────────────────────────

async function waitForOutcome(tabId, baseline, { timeoutMs = CONFIRM_TIMEOUT_MS } = {}) {
  const started = Date.now();
  let errorPolls = 0;
  while (Date.now() - started < timeoutMs) {
    await delay(2000);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Stop("failed", "The application tab was closed.");
    }
    if (tab.status !== "complete") continue;
    const s = await pageState(tabId);
    if (s.otp) return { kind: "otp", state: s };
    if (s.captcha) return { kind: "captcha", state: s };
    // A page that already said "thank you" before submit proves nothing.
    if (s.confirmed && (!baseline.confirmed || !s.submit)) return { kind: "confirmed", via: "page" };
    // The submit watcher also fires when the form is swapped for a code step,
    // so its signal only counts once the page shows no code, CAPTCHA or form.
    if (submittedSignal) {
      if (!s.submit && !s.errors.length) return { kind: "confirmed", via: submittedSignal };
      submittedSignal = null;
    }
    if (s.errors.length && s.submit) {
      errorPolls += 1;
      if (errorPolls >= 3) return { kind: "errors", state: s };
    } else {
      errorPolls = 0;
    }
  }
  return { kind: "timeout" };
}

async function solveCode(tabId, job, sinceSec) {
  const tried = [];
  const started = Date.now();
  step("Waiting for the emailed verification code…");
  while (Date.now() - started < OTP_TIMEOUT_MS) {
    // Several runs can wait on codes at once: only take a code from mail that
    // names this company, unless this is the only run waiting.
    const alone = console_ ? console_.otpWaiters(jobId) <= 1 : true;
    const useCompany = job.company && !(alone && Date.now() - started > 90_000);
    let res;
    try {
      res = await api.getVerificationCode({ since: sinceSec, company: useCompany ? job.company : undefined, exclude: tried });
    } catch (err) {
      throw needsYou("Enter the verification code from your email: " + ((err && err.message) || "the inbox could not be read"));
    }
    if (!res || res.connected === false) {
      throw needsYou("Enter the verification code from your email. Connect your inbox in NAO to let auto-apply do this.");
    }
    if (res.code) {
      tried.push(res.code);
      step(`Entering the code from ${res.from || "your email"}…`);
      const s = await pageState(tabId);
      if (!s.otp) return;
      const out = await pageCall(tabId, "fillOtp", res.code, s.otp.frameId);
      if (!out.length || !out[0].filled) throw needsYou("Could not type the verification code. It is " + res.code + ".");
      if (!out[0].clicked) {
        await delay(800);
        const again = await pageState(tabId);
        if (again.submit && !again.otp) await pageCall(tabId, "submit", null, again.submit.frameId);
      }
      await delay(3000);
      const after = await pageState(tabId);
      if (!after.otp || after.confirmed) return;
      step("That code was not accepted, waiting for a newer one…");
    }
    await delay(OTP_POLL_MS);
  }
  throw needsYou("No verification code arrived. Check your email and enter it on the page.");
}

async function submitAndConfirm(tab, job) {
  const tabId = tab.id;
  const baseline = await pageState(tabId);
  if (!baseline.submit) {
    throw needsYou(baseline.next ? `Filled, but the form continues with "${baseline.next.label}". Finish the remaining steps.` : "Filled, but no Submit button was found. Submit it on the page.");
  }
  if (baseline.submit.disabled) throw needsYou("Submit is disabled. Something on the form still needs attention.");
  step("Submitting…");
  const sinceSec = Date.now() / 1000 - 30;
  const clicked = await pageCall(tabId, "submit", null, baseline.submit.frameId);
  if (!clicked.length || !clicked[0].clicked) throw needsYou("Could not click Submit. Submit it on the page.");
  report({ submittedAt: Date.now() });

  for (let round = 0; round < 3; round++) {
    const outcome = await waitForOutcome(tabId, baseline);
    if (outcome.kind === "confirmed") return outcome.via;
    if (outcome.kind === "otp") {
      if (console_) console_.otpWait(jobId, true);
      try {
        await solveCode(tabId, job, sinceSec);
      } finally {
        if (console_) console_.otpWait(jobId, false);
      }
      continue;
    }
    if (outcome.kind === "captcha") throw needsYou("The site wants a CAPTCHA. Solve it and submit.");
    if (outcome.kind === "errors") throw needsYou("The form was rejected: " + outcome.state.errors.join("; "));
    throw needsYou("Submitted, but no confirmation showed up. Check the page.");
  }
  throw needsYou("The site kept asking for a code. Finish it on the page.");
}

// ── main ────────────────────────────────────────────────────────────────────

async function boot() {
  const [prefs, user, token] = await Promise.all([storage.loadPrefs(), storage.getCurrentUser(), storage.getToken()]);
  if (!user || !token) throw new Stop("failed", "Sign in to the NAO extension first.");
  let cache = await storage.getCache(user.user_id);
  if (!cache || !cache.settings) {
    const settings = await api.getSettings().catch(() => null);
    cache = { ...(cache || {}), settings };
  }
  setState({ ...prefs, user, cache, autoApply: true, view: "job" });
  setFocusGate((tabId) => (console_ ? console_.focusTab(tabId) : Promise.resolve()));
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "AA_SUBMITTED") {
      if (ownTabId != null && msg.tabId === ownTabId) submittedSignal = msg.reason || "submit";
      return;
    }
    handleAutofillMessage(msg, sender);
  });
}

async function run(cfg) {
  await boot();
  step("Opening the job…");
  const session = await api.openSession(jobId, { fresh: true });
  const job = jobFromSession(session);
  report({ title: job.title, company: job.company });
  if (job.applied) throw skipped("Already marked applied.");
  if (!job.url) throw skipped("This job has no application link.");
  if (!docsComplete(job.docs)) throw skipped("Resume or cover letter is not built yet.");

  const target = applyPageUrl(detectPlatform({ pageUrl: job.url }), job.url);
  let tab = await openTab(target, cfg.windowId);

  // Redirects (short links, career sites embedding an ATS) decide the real platform.
  let platform = detectPlatform({ pageUrl: tab.url });
  const better = applyPageUrl(platform, tab.url || "");
  if (better && better !== tab.url) tab = await navigate(tab.id, better);
  platform = detectPlatform({ pageUrl: tab.url });
  report({ platform });
  if (AGGREGATOR_HOSTS.some((h) => hostOf(tab.url).endsWith(h))) {
    throw needsYou("This is a job board listing. Open the employer's application from it.");
  }
  if (NEEDS_ACCOUNT.has(platform)) throw needsYou(`${platform} needs an account. Sign in and finish the application.`);

  job.engine = resolveEngine({ snapshot: job.snapshot, pageUrl: tab.url });
  setState({ job });

  step("Filling the application…");
  const result = await fill(tab);
  report({ filled: result.filled });
  if (result.needs.length) throw needsYou("Needs your input: " + result.needs.slice(0, 4).join("; "));

  await delay(1500);
  const check = await pageState(tab.id);
  if (check.missing.length) throw needsYou("Required fields are still empty: " + check.missing.slice(0, 5).join(", "));
  if (check.captcha) throw needsYou("The site wants a CAPTCHA. Solve it and submit.");

  if (cfg.dryRun) return { status: "filled", message: "Filled (dry run). Review and submit it yourself, or turn dry run off." };
  if (!cfg.submitPlatforms.includes(platform)) {
    throw needsYou("Filled. Auto-submit is off for this site, so review and submit it.");
  }

  const via = await submitAndConfirm(tab, job);
  step("Marking applied…");
  await api.markApplied([jobId]);
  // Awaited: the console removes this frame as soon as the run finishes.
  await api.updateSession(jobId, "completed").catch(() => {});
  return { status: "applied", message: `Submitted and confirmed (${via}).` };
}

async function main() {
  if (!console_ || !jobId) return;
  const cfg = console_.config(jobId);
  let outcome;
  try {
    outcome = await run(cfg);
  } catch (err) {
    outcome =
      err instanceof Stop
        ? { status: err.status, message: err.message, ...err.extra }
        : { status: "failed", message: (err && err.message) || String(err) };
  }
  if (ownTabId != null) await chrome.storage.session.remove(AA_TAB_PREFIX + ownTabId).catch(() => {});
  console_.finish(jobId, { ...outcome, tabId: ownTabId });
}

void main();
