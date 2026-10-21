// Pure helpers for the auto-apply console: queue order and eligibility, run
// stages, and history stats. No chrome.* or DOM, so they are unit tested.

import { EASE_TIER, NEEDS_ACCOUNT } from "./platforms.js";

export const ORDERS = [
  { value: "ease", label: "Easiest sites first", hint: "Fewest steps and highest success rate first." },
  { value: "match", label: "Best match first", hint: "Highest match score first, on any enabled site." },
  { value: "newest", label: "Newest first", hint: "Most recently added jobs first." },
];

export const STAGES = [
  { id: "open", label: "Open" },
  { id: "fill", label: "Fill" },
  { id: "submit", label: "Submit" },
  { id: "verify", label: "Verify" },
  { id: "done", label: "Done" },
];

/** 1 (easiest) to 6 (job board listing). */
export function easeTier(platform) {
  if (platform === "board") return 6;
  if (NEEDS_ACCOUNT.has(platform)) return 5;
  return EASE_TIER[platform] || 4;
}

export function easeLabel(platform) {
  const tier = easeTier(platform);
  if (tier <= 1) return "Easy";
  if (tier === 2) return "Simple";
  if (tier === 3) return "Moderate";
  if (tier === 4) return "Varies";
  return "Manual";
}

export function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Ranked queue -> the order and filter the user picked. Never mutates.
 * Pinned jobs come first; jobs set aside for later come after all others.
 */
export function arrangeQueue(queue, { order = "ease", minScore = 0, pinned = [], later = new Set() } = {}) {
  const pins = new Map(pinned.map((id, i) => [id, i]));
  const kept = queue.filter((q) => pins.has(q.id) || !minScore || (q.score != null && q.score >= minScore));
  const by = {
    ease: (a, b) => a.tier - b.tier || b.score - a.score,
    match: (a, b) => b.score - a.score || a.tier - b.tier,
    newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.tier - b.tier,
  }[order] || ((a, b) => a.tier - b.tier);
  return kept.sort((a, b) => {
    const pa = pins.has(a.id) ? pins.get(a.id) : Infinity;
    const pb = pins.has(b.id) ? pins.get(b.id) : Infinity;
    return pa - pb || Number(later.has(a.id)) - Number(later.has(b.id)) || by(a, b);
  });
}

/** History statuses whose job may be picked up again by the queue. */
export const RETRYABLE = new Set(["failed", "later"]);

const companyKey = (name) => String(name || "").trim().toLowerCase();

/** Applications per company today: submitted ones in history plus live runs. */
export function companyLoad(history, runs, now = Date.now()) {
  const since = startOfDay(now);
  const load = new Map();
  const add = (name) => {
    const k = companyKey(name);
    if (k) load.set(k, (load.get(k) || 0) + 1);
  };
  for (const h of Object.values(history || {})) if (h.status === "applied" && h.at >= since) add(h.company);
  for (const r of Object.values(runs || {})) add(r.company);
  return load;
}

/** Index of the next queue entry that respects the per-company cap; -1 if none. */
export function nextRunnable(queue, { history, runs, perCompany = 0, now = Date.now() } = {}) {
  if (!perCompany) return queue.length ? 0 : -1;
  const load = companyLoad(history, runs, now);
  return queue.findIndex((q) => !companyKey(q.company) || (load.get(companyKey(q.company)) || 0) < perCompany);
}

/** Where a live run is, from its status and the runner's step messages. */
export function stageOf(run) {
  if (!run) return "open";
  if (run.status === "applied") return "done";
  const m = String(run.message || "").toLowerCase();
  if (/marking applied/.test(m)) return "done";
  if (/code|verif/.test(m)) return "verify";
  if (run.submittedAt || /submitting/.test(m)) return "submit";
  if (run.platform && !/^opening|^starting/.test(m)) return "fill";
  return "open";
}

export function stageIndex(stage) {
  return Math.max(0, STAGES.findIndex((s) => s.id === stage));
}

export function appliedToday(history, now = Date.now()) {
  const since = startOfDay(now);
  return Object.values(history || {}).filter((h) => h.status === "applied" && h.at >= since).length;
}

export function isWaiting(h) {
  return h.status === "needs_you" || h.status === "filled" || (h.status === "failed" && h.tabOpen);
}

const LEFT_FOR_USER = new Set(["needs_you", "filled", "failed"]);
export const CLOSED_UNSUBMITTED = "You closed the tab without submitting, so it moved to apply later.";

/**
 * The user closed a tab auto-apply left for them without submitting: they
 * want to come back to it, so it joins the end of the queue as "apply later".
 * Null when the entry is not one waiting on them.
 */
export function closedWithoutSubmit(entry, now = Date.now()) {
  if (!entry || !LEFT_FOR_USER.has(entry.status)) return null;
  return { ...entry, status: "later", message: CLOSED_UNSUBMITTED, at: now, tabOpen: false };
}

const NOT_ATTEMPTS = new Set(["skipped", "later", "invalid"]);

/**
 * Finished attempts in the last `days`. A dry run's filled form is a success:
 * it is as far as a dry run goes. Skipped, later and invalid jobs were never
 * attempts.
 */
export function successStats(history, { days = 7, now = Date.now() } = {}) {
  const since = now - days * 24 * 60 * 60 * 1000;
  const recent = Object.values(history || {}).filter((h) => h.at >= since && !NOT_ATTEMPTS.has(h.status));
  const applied = recent.filter((h) => h.status === "applied").length;
  const filled = recent.filter((h) => h.status === "filled").length;
  const ok = applied + filled;
  return { attempts: recent.length, applied, filled, rate: recent.length ? Math.round((ok / recent.length) * 100) : null };
}

export function filterHistory(entries, { status = "all", q = "" } = {}) {
  const term = q.trim().toLowerCase();
  return entries.filter(([, h]) => {
    if (status !== "all" && h.status !== status) return false;
    if (!term) return true;
    return [h.title, h.company, h.platform, h.message].some((v) => String(v || "").toLowerCase().includes(term));
  });
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

export function timeAgo(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
