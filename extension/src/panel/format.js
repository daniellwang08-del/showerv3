// Pure formatting helpers shared by the side panel views. No DOM, no chrome.*,
// so they run under node:test.

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 10_000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return v.toLocaleString("en-US");
}

/** "just now", "5m ago", "3h ago", "2d ago", "3w ago", "4mo ago", "1y ago". */
export function timeAgo(value, now = Date.now()) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** One scale everywhere: strong >= 80, good >= 65, fair >= 50, else weak. */
export function matchTone(score) {
  if (score == null || Number.isNaN(Number(score))) return null;
  const s = Number(score);
  if (s >= 80) return "strong";
  if (s >= 65) return "good";
  if (s >= 50) return "fair";
  return "weak";
}

export function workMode(value, isRemote = false) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "remote" || mode === "hybrid" || mode === "onsite") return mode;
  if (/hybrid|flexible/.test(mode)) return "hybrid";
  if (/remote|wfh|work[- ]from[- ]home/.test(mode)) return "remote";
  if (/on-?site|on site|in[- ]office|in-person/.test(mode)) return "onsite";
  return isRemote ? "remote" : null;
}

export const WORK_MODE_LABEL = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };

// Application platforms (where the apply form lives) and job boards (where the
// listing came from). Labels only; the panel draws neutral monograms.
const PLATFORMS = {
  workday: "Workday",
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workable: "Workable",
  smartrecruiters: "SmartRecruiters",
  icims: "iCIMS",
  breezy: "Breezy",
  jobvite: "Jobvite",
  applytojob: "JazzHR",
  recruiterflow: "Recruiterflow",
  pinpoint: "Pinpoint",
  manatal: "Manatal",
  jobdiva: "JobDiva",
  bamboohr: "BambooHR",
  taleo: "Taleo",
  linkedin: "LinkedIn",
  dice: "Dice",
  wellfound: "Wellfound",
  jobright: "Jobright",
  remoterocketship: "Remote Rocketship",
  welcometothejungle: "Welcome to the Jungle",
  manual: "Added by you",
  admin_manual: "Added by admin",
};

export function platformFromUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return null;
  const rules = [
    [/myworkdayjobs|workday\.com|wd\d\.myworkday/, "workday"],
    [/greenhouse\.io/, "greenhouse"],
    [/lever\.co/, "lever"],
    [/ashbyhq\.com/, "ashby"],
    [/workable\.com/, "workable"],
    [/smartrecruiters\.com/, "smartrecruiters"],
    [/icims\.com/, "icims"],
    [/breezy\.hr/, "breezy"],
    [/jobvite\.com/, "jobvite"],
    [/applytojob\.com|resumator/, "applytojob"],
    [/recruiterflow\.com|rfcareers\./, "recruiterflow"],
    [/careers-page\.com|manatal\.com/, "manatal"],
    [/jobdiva\.com/, "jobdiva"],
    [/bamboohr\.com/, "bamboohr"],
    [/taleo\.net/, "taleo"],
    [/linkedin\./, "linkedin"],
    [/dice\.com/, "dice"],
    [/wellfound|angel\.co/, "wellfound"],
  ];
  for (const [re, id] of rules) if (re.test(u)) return id;
  if (/^https?:\/\/careers\./.test(u) && /\/postings\/.+\/applications/.test(u)) return "pinpoint";
  return null;
}

export function platformLabel(id) {
  const k = String(id || "").toLowerCase().trim();
  if (!k) return null;
  if (PLATFORMS[k]) return PLATFORMS[k];
  return k
    .split(/[_\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function monogram(label) {
  const words = String(label || "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const done = (v) => String(v || "").toLowerCase() === "completed";

/** Where a job is in the tailoring pipeline, for one status chip. */
export function resumeStage(job) {
  const content = String(job.content_generation_status || "").toLowerCase();
  const docx = String(job.resume_build_status || job.resume_docx_status || "").toLowerCase();
  const pdf = String(job.resume_pdf_status || "").toLowerCase();
  if (done(docx) || done(pdf)) return { id: "ready", label: "Resume ready", tone: "ok" };
  if (content === "failed" || content === "skipped" || docx === "failed" || pdf === "failed") {
    return { id: "failed", label: "Resume failed", tone: "danger" };
  }
  if (content === "pending" || content === "processing" || docx === "processing" || pdf === "processing" || (done(content) && !done(docx))) {
    return { id: "building", label: "Tailoring", tone: "warn" };
  }
  return { id: "none", label: "No resume yet", tone: "muted" };
}

/** Normalized card model for any dashboard job row. */
export function toJobCard(j) {
  const platform = platformFromUrl(j.normalized_url || j.source_url);
  const board = j.added_from && j.added_from !== "job_sites" ? j.added_from : j.source;
  return {
    id: String(j.id),
    title: (j.title || "").trim() || "Untitled role",
    company: (j.company || "").trim(),
    location: (j.location || "").trim(),
    mode: workMode(j.work_mode, j.is_remote),
    score: j.match_overall_score != null ? Math.round(Number(j.match_overall_score)) : null,
    matching: !!j.match_in_progress,
    platform,
    platformLabel: platformLabel(platform),
    boardLabel: platformLabel(board),
    salary: (j.salary_raw || "").trim() || null,
    addedAt: j.pool_added_at || j.created_at || null,
    postedAt: j.posted_date || null,
    applied: !!j.applied_at,
    appliedAt: j.applied_at || null,
    stage: resumeStage(j),
    pumblePosted: !!j.pumble_posted_at,
    url: j.source_url || j.normalized_url || "",
  };
}

// ── markdown (assistant answers) ─────────────────────────────────────────────
// Everything is HTML-escaped before formatting, so the output never carries
// markup from the model. Tolerates partial text while streaming.

function mdInline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function renderMarkdown(text) {
  const out = [];
  let listType = null;
  let para = [];
  let inCode = false;
  let code = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (listType) out.push(`</${listType}>`);
    listType = null;
  };
  const openList = (type) => {
    if (listType === type) return;
    closeList();
    out.push(`<${type}>`);
    listType = type;
  };
  for (const line of String(text || "").split("\n")) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
      } else {
        flushPara();
        closeList();
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const t = line.trim();
    let m;
    if (!t) {
      flushPara();
      closeList();
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) {
      flushPara();
      closeList();
      out.push(`<h4>${mdInline(escapeHtml(m[2]))}</h4>`);
    } else if ((m = /^[-*]\s+(.*)$/.exec(t))) {
      flushPara();
      openList("ul");
      out.push(`<li>${mdInline(escapeHtml(m[1]))}</li>`);
    } else if ((m = /^\d+\.\s+(.*)$/.exec(t))) {
      flushPara();
      openList("ol");
      out.push(`<li>${mdInline(escapeHtml(m[1]))}</li>`);
    } else if ((m = /^>\s?(.*)$/.exec(t))) {
      flushPara();
      closeList();
      out.push(`<blockquote>${mdInline(escapeHtml(m[1]))}</blockquote>`);
    } else {
      closeList();
      para.push(mdInline(escapeHtml(line)));
    }
  }
  if (inCode && code.length) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushPara();
  closeList();
  return out.join("");
}

/** Plain text for copying: what you paste matches what you read. */
export function markdownToPlain(text) {
  return String(text || "")
    .replace(/```([\s\S]*?)```/g, (_, c) => c.trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/__([^_]+?)__/g, "$1")
    .replace(/\*([^*\n]+?)\*/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^(\s*)[-*]\s+/gm, "$1- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Same rules as frontend/src/utils/extractHttpUrls.ts.
const HTTP_URL_RE = /https?:\/\/[^\s<>"'`\uFF09\]}>\uFF0C\u3002\uFF1B\u3001]+/gi;

export function extractHttpUrls(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || "").match(HTTP_URL_RE) || []) {
    const url = raw.trim().replace(/[.,;:!?)\]]+$/g, "");
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

export function messageOf(err, fallback = "Something went wrong.") {
  if (!err) return fallback;
  if (typeof err === "string") return err;
  return err.message || fallback;
}
