// Which ready jobs auto-apply can finish alone, and in what order.

import { detectPlatform } from "../engines.js";

// Lower tier = easier: one page, stable markup, engine fills it end to end.
export const EASE_TIER = {
  greenhouse: 1,
  lever: 1,
  ashby: 1,
  workable: 2,
  pinpoint: 2,
  applytojob: 2,
  recruiterflow: 2,
  manatal: 2,
  jobdiva: 2,
  smartrecruiters: 3,
  breezy: 3,
  jobvite: 3,
  bamboohr: 4,
  generic: 4,
};

// These need an account (sign-up, password, email link) before the form.
export const NEEDS_ACCOUNT = new Set(["workday", "icims", "taleo"]);

export const PLATFORM_LABEL = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workable: "Workable",
  pinpoint: "Pinpoint",
  applytojob: "JazzHR",
  recruiterflow: "Recruiterflow",
  manatal: "Manatal",
  jobdiva: "JobDiva",
  smartrecruiters: "SmartRecruiters",
  breezy: "Breezy",
  jobvite: "Jobvite",
  bamboohr: "BambooHR",
  generic: "Career sites",
  workday: "Workday",
  icims: "iCIMS",
  taleo: "Taleo",
  board: "Job board listings",
};

// Auto-submit by default only where the engine fills the whole form reliably.
export const DEFAULT_SUBMIT_PLATFORMS = ["greenhouse", "lever", "ashby", "workable", "pinpoint", "applytojob", "recruiterflow", "manatal", "jobdiva"];

// Listing pages, not applications: the apply button leads somewhere else.
export const AGGREGATOR_HOSTS = [
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "dice.com",
  "jobright.ai",
  "simplyhired.com",
  "monster.com",
  "builtin.com",
  "wellfound.com",
  "remote.co",
  "weworkremotely.com",
  "remoteok.com",
  "adzuna.com",
  "careerbuilder.com",
  "talent.com",
  "welcometothejungle.com",
  "otta.com",
  "hiring.cafe",
];

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Platform id for a job URL; job board listing pages are "board". */
export function platformOfUrl(url) {
  const host = hostOf(url);
  if (host && AGGREGATOR_HOSTS.some((h) => host === h || host.endsWith("." + h))) return "board";
  return detectPlatform({ pageUrl: url });
}

/** Listing URL -> the URL that shows the application form, where it differs. */
export function applyPageUrl(platform, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (platform === "lever" && parts.length === 2) {
    u.pathname = `/${parts[0]}/${parts[1]}/apply`;
  } else if (platform === "ashby" && parts.length === 2) {
    u.pathname = `/${parts[0]}/${parts[1]}/application`;
  } else if (platform === "workable" && parts.length === 3 && parts[1] === "j") {
    u.pathname = `/${parts.join("/")}/apply/`;
  } else if (platform === "breezy" && parts.length === 2 && parts[0] === "p") {
    u.pathname = `/p/${parts[1]}/apply`;
  } else if (platform === "manatal" && parts.length === 3 && parts[1] === "job") {
    u.pathname = `/${parts.join("/")}/apply`;
  } else {
    return url;
  }
  return u.toString();
}

/**
 * Dashboard rows -> queue entries, easiest first, then best match.
 * `allowed` is the set of platform ids the user enabled.
 */
export function rankJobs(rows, { allowed, skip = new Set() } = {}) {
  const out = [];
  for (const j of rows || []) {
    const id = String(j.id || j.job_id || "");
    if (!id || skip.has(id) || j.applied_at) continue;
    const url = j.source_url || j.normalized_url || j.url || "";
    if (!url) continue;
    const platform = platformOfUrl(url);
    if (NEEDS_ACCOUNT.has(platform) && !(allowed && allowed.has(platform))) continue;
    if (allowed && !allowed.has(platform)) continue;
    const tier = platform === "board" ? 6 : NEEDS_ACCOUNT.has(platform) ? 5 : EASE_TIER[platform] || 4;
    const score = j.match_overall_score != null ? Number(j.match_overall_score) : -1;
    out.push({
      id,
      url,
      platform,
      tier,
      score,
      title: (j.title || "").trim() || "Untitled role",
      company: (j.company || "").trim(),
      createdAt: j.created_at ? Date.parse(j.created_at) || 0 : 0,
    });
  }
  out.sort((a, b) => a.tier - b.tier || b.score - a.score);
  return out;
}
