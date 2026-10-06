// Single source of truth for the side panel. Components read it through
// useAppState(); everything else reads the live `state` view and writes through
// setState(). Notifications are batched per microtask, so a burst of updates
// produces one render.

import { useEffect, useState } from "../lib/preact.js";

export function emptyAutofill() {
  return {
    active: false,
    picking: false,
    discovering: false,
    tabId: null,
    engine: null,
    fields: [],
    specs: [],
    statuses: {},
    needsUser: [],
    running: false,
    runStatus: null,
    error: null,
    reports: [],
    done: false,
    autoLoop: false,
    loopStatus: null,
    loopStop: false,
    loopFinished: null,
    loopMessage: null,
    primaryFrameId: null,
    aaLogs: [],
  };
}

export function emptyList() {
  return { items: [], total: 0, page: 1, pages: 1, loading: false, error: null, key: null, loadedAt: 0 };
}

function initialState() {
  return {
    // loading | login | home | list | job | tailor | stats | settings | progress
    view: "loading",
    listId: null,
    user: null,
    backendUrl: "",
    cache: null,
    profileChanged: [],

    // preferences (storage.loadPrefs)
    minScore: 0,
    autoAdvance: true,
    autoSubmit: false,
    answerStrategy: "",
    pageSize: 25,
    dailyApplyTarget: 50,
    askHotkey: null,
    chatStyle: "standard",
    answerType: "",

    home: { data: null, loading: false, error: null, loadedAt: 0 },
    live: "offline", // online | connecting | offline
    list: emptyList(),
    filters: { q: "", sort: "created_at", remoteOnly: false, minScore: 0 },
    inProgress: { items: [], loading: false, error: null },

    job: null,
    jobError: null,
    applyContext: null,
    chat: { messages: [], streaming: false },
    autofill: emptyAutofill(),
    reportNotice: null,
    postingToPumble: false,
    skipping: false,

    tailor: { tab: "paste", runs: [], library: null, libraryLoading: false },
    stats: { period: "week", progress: null, scraper: null, loading: false },
    addJobs: null,

    toast: null,
    modal: null,
    hotkeyRecording: false,
  };
}

let current = initialState();
const listeners = new Set();
let pending = false;

/** Read-only live view of the current state. */
export const state = new Proxy(
  {},
  {
    get: (_t, key) => current[key],
    has: (_t, key) => key in current,
    set() {
      throw new Error("state is read-only; use setState()");
    },
  }
);

export function getState() {
  return current;
}

/** Shallow-merge a patch (or a function of the current state returning one). */
export function setState(patch) {
  const next = typeof patch === "function" ? patch(current) : patch;
  if (!next) return;
  current = { ...current, ...next };
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    for (const fn of listeners) fn(current);
  });
}

export function setAutofill(patch) {
  setState({ autofill: { ...current.autofill, ...patch } });
}

export function resetState(patch = {}) {
  current = { ...initialState(), ...patch };
  for (const fn of listeners) fn(current);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAppState() {
  const [snapshot, setSnapshot] = useState(current);
  useEffect(() => {
    setSnapshot(current);
    return subscribe(setSnapshot);
  }, []);
  return snapshot;
}
