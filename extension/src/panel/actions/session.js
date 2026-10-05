// Startup, sign-in, sign-out, and account data.

import * as api from "../../api.js";
import * as storage from "../../storage.js";
import { teardownAutofill } from "../autofill/index.js";
import { messageOf } from "../format.js";
import { live } from "../live.js";
import { resetState, setState, state } from "../state.js";
import { toast } from "../toast.js";
import { goHome, loadHome } from "./home.js";
import { consumePendingHandoffs } from "./job.js";

export async function init() {
  api.onUnauthorized((reason) => {
    if (state.view === "login") return;
    void endSession(reason || "Your session expired. Sign in again.");
  });
  await storage.dropLegacyCatalog();
  await storage.syncBackendFromOpenTabs();
  const [prefs, user, token, backendUrl] = await Promise.all([
    storage.loadPrefs(),
    storage.getCurrentUser(),
    storage.getToken(),
    storage.getBackendUrl(),
  ]);
  setState({ ...prefs, backendUrl });

  if (user && token) {
    const cache = await storage.getCache(user.user_id);
    setState({ user, cache });
    await goHome();
    live.start();
    void refreshAccount({ quiet: true });
    await consumePendingHandoffs();
    return;
  }
  if (token) await storage.clearToken();
  if (user) await storage.clearCurrentUser();
  setState({ view: "login" });
}

/** The worker stored a session from website sign-in; start over with it. */
export async function reloadSession() {
  live.stop();
  await init();
  if (state.user) toast(`Signed in as ${state.user.email}.`, "ok");
}

/** @returns {Promise<string|null>} error message, or null on success */
export async function signIn({ email, password, remember }) {
  const backendUrl = await storage.getBackendUrl();
  setState({ backendUrl });
  if (!(await api.ensureHostPermission(backendUrl))) {
    return `Allow access to ${new URL(backendUrl).host} to sign in.`;
  }
  try {
    const user = await api.login(email.trim(), password);
    await storage.setRememberedEmail(remember ? email : "");
    setState({ user, cache: await storage.getCache(user.user_id) });
    await refreshAccount({ quiet: true });
    await goHome();
    live.start();
    await consumePendingHandoffs();
    return null;
  } catch (err) {
    return messageOf(err, "Sign in failed.");
  }
}

export async function signOut() {
  await endSession(null);
}

async function endSession(message) {
  live.stop();
  await teardownAutofill().catch(() => {});
  chrome.runtime.sendMessage({ type: "ASK_HOTKEY_DISARM" }).catch(() => {});
  await api.logout();
  await storage.clearCurrentUser();
  const prefs = await storage.loadPrefs();
  resetState({ ...prefs, view: "login", backendUrl: await storage.getBackendUrl() });
  if (message) toast(message, "warn");
}

/** Profile, settings and data-version snapshot used by autofill and chat. */
export async function refreshAccount({ quiet = false } = {}) {
  if (!state.user) return;
  const [profile, profileText, settings, dataVersion] = await Promise.all([
    api.getProfile().catch(() => null),
    api.getProfileText().catch(() => null),
    api.getSettings().catch(() => null),
    api.getDataVersion().catch(() => null),
  ]);
  const cache = {
    profile,
    profileText: profileText && profileText.profile_openai_text,
    settings,
    dataVersion,
  };
  await storage.setCache(state.user.user_id, cache);
  setState({ cache, profileChanged: [] });
  if (!quiet) toast("Profile and settings are up to date.", "ok");
}

const SECTION_LABELS = {
  profile: "profile",
  settings: "settings",
  prompts: "assistant prompts",
  templates: "resume templates",
};

/** Flags account sections edited elsewhere since the last refresh. */
export async function checkProfileChanged() {
  try {
    const version = await api.getDataVersion();
    const prev = state.cache && state.cache.dataVersion;
    if (!prev || !version || !prev.sections) return;
    const changed = Object.entries(version.sections || {})
      .filter(([section, hash]) => prev.sections[section] !== hash)
      .map(([section]) => SECTION_LABELS[section] || section);
    setState({ profileChanged: changed });
  } catch {
    /* advisory only */
  }
}

/** Point the extension at a different server; signs out when it changes. */
export async function changeServer(url) {
  const current = await storage.getBackendUrl();
  const next = url ? storage.normalizeBackendUrl(url) : null;
  if (next) {
    try {
      new URL(next);
    } catch {
      return "Enter a valid address, for example https://nao.it.com";
    }
    if (!(await api.ensureHostPermission(next))) return `Allow access to ${new URL(next).host} to use it.`;
  }
  await storage.setManualBackendUrl(next);
  const resolved = await storage.getBackendUrl();
  setState({ backendUrl: resolved });
  if (resolved !== current && state.user) {
    await endSession(`Server changed to ${new URL(resolved).host}. Sign in again.`);
  }
  return null;
}

export async function savePreference(key, value) {
  const next = await storage.savePref(key, value);
  setState({ [key]: next });
  return next;
}

export async function updateAccountSetting(patch) {
  try {
    const settings = await api.updateSettings(patch);
    const cache = { ...(state.cache || {}), settings: { ...((state.cache && state.cache.settings) || {}), ...(settings || patch) } };
    if (state.user) await storage.setCache(state.user.user_id, cache);
    setState({ cache });
    return null;
  } catch (err) {
    return messageOf(err, "Could not save the setting.");
  }
}

export { loadHome };
