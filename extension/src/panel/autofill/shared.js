// Helpers shared by the form, Workday and per-platform autofill modules.

import * as api from "../../api.js";
import * as tabMsg from "../../tab-messaging.js";
import { state } from "../state.js";

export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  prefs.resume_source = state.resumeSource === "original" ? "original" : "tailored";
  return prefs;
}

export function resumeSourcePref() {
  return buildPreferences().resume_source;
}

// One autofill run asks for the same profile from several platform steps.
const PROFILE_TTL_MS = 120_000;
const profileCache = new Map();

export function getAutofillProfile(jobId, resumeSource) {
  const key = `${jobId}:${resumeSource}`;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.promise;
  const promise = api.getAutofillProfile(jobId, resumeSource).catch((err) => {
    profileCache.delete(key);
    throw err;
  });
  profileCache.set(key, { at: Date.now(), promise });
  return promise;
}

export function clearProfileCache() {
  profileCache.clear();
}
