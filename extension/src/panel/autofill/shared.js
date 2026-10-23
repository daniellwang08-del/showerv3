// Helpers shared by the form, Workday and per-platform autofill modules.

import * as api from "../../api.js";
import * as tabMsg from "../../tab-messaging.js";
import { state } from "../state.js";

export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Parallel auto-apply runs share one OS focus: the console installs a gate that
// focuses a tab only while no other run holds it.
let focusGateFn = null;

export function setFocusGate(fn) {
  focusGateFn = typeof fn === "function" ? fn : null;
}

export function focusGate() {
  return focusGateFn;
}

/**
 * Whether an engine that can press the final Submit itself (JobDiva, Workday)
 * may do so. Auto-apply decides per run (dry run, sites allowed to submit);
 * the panel's own Auto-submit preference never applies there.
 */
export function submitAllowed() {
  return state.autoApply ? state.autoApplySubmit === true : state.autoSubmit === true;
}

// Autofill payloads contain profile data, so tracing is opt-in:
// run `localStorage.naoDebug = "1"` in the panel console to enable it.
const DEBUG = (() => {
  try {
    return globalThis.localStorage && localStorage.getItem("naoDebug") === "1";
  } catch {
    return false;
  }
})();

export function debugLog(...args) {
  if (DEBUG) console.debug("[nao]", ...args);
}

/** Content-script frame that owns the application form (embedded ATS iframes). */
export function autofillFrameId() {
  const af = state.autofill;
  if (af && af.primaryFrameId != null) return af.primaryFrameId;
  for (const f of (af && af.fields) || []) {
    if (f.frameId != null && (f.controlCount || 0) > 0) return f.frameId;
  }
  return null;
}

export function tabSend(tabId, msg, frameId) {
  const fid = frameId != null ? frameId : autofillFrameId();
  return tabMsg.sendTabMessage(tabId, msg, fid != null ? fid : 0);
}

export function tabBroadcast(tabId, msg) {
  return tabMsg.broadcastTabMessage(tabId, msg);
}

/** Preferences forwarded to the autofill LLM; panel prefs win over account settings. */
export function buildPreferences() {
  const s = (state.cache && state.cache.settings) || {};
  const prefs = {};
  const strategy =
    (state.answerStrategy || "").trim() ||
    s.application_answer_strategy ||
    s.autofill_answer_strategy ||
    s.answer_strategy;
  if (strategy) prefs.answer_strategy = String(strategy);
  return prefs;
}

/** Résumé used for applications, set on the web Preferences page (account-wide). */
export function accountResumeSource() {
  const s = (state.cache && state.cache.settings) || {};
  return s.application_resume_source === "original" ? "original" : "tailored";
}

// One autofill run asks for the same profile from several platform steps.
const PROFILE_TTL_MS = 120_000;
const profileCache = new Map();

/** The server picks original vs tailored from the account setting; the
 *  second argument is accepted for older callers and ignored. */
export function getAutofillProfile(jobId, _legacySource) {
  const key = String(jobId);
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.promise;
  const promise = api.getAutofillProfile(jobId).catch((err) => {
    profileCache.delete(key);
    throw err;
  });
  profileCache.set(key, { at: Date.now(), promise });
  return promise;
}

/** The résumé an application uploads: PDF first, the Word file when only that exists. */
export async function downloadApplicationResume(jobId) {
  try {
    return await api.downloadResumeFile(jobId, "resume_pdf");
  } catch (pdfErr) {
    try {
      return await api.downloadResumeFile(jobId, "resume_docx");
    } catch {
      throw pdfErr;
    }
  }
}

export function clearProfileCache() {
  profileCache.clear();
}

// A password satisfying the usual ATS rule (iCIMS states it in the field's
// title, Workday lists it): 8+ characters with a lowercase, an uppercase, a
// digit and a special character. Ambiguous glyphs (l/1/O/0) are left out so
// the candidate can retype it from the panel without misreading it.
export function generatePortalPassword() {
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
