// Report an issue: a description, screenshots (uploaded, pasted, or captured
// from the page), and files such as a resume. The draft survives leaving the
// view, so people can go reproduce the problem and come back.

import * as api from "../../api.js";
import { messageOf } from "../format.js";
import { emptyReport, setState, state } from "../state.js";
import { getWebWorkTab } from "../tabs.js";
import { toast } from "../toast.js";

export const DEFAULT_LIMITS = {
  max_attachments: 10,
  max_file_bytes: 10 * 1024 * 1024,
  max_total_bytes: 25 * 1024 * 1024,
};

export const DEFAULT_CATEGORIES = [
  { value: "bug", label: "Something is broken" },
  { value: "autofill", label: "Autofill or applying" },
  { value: "jobs", label: "Jobs and matching" },
  { value: "resume", label: "Resume or cover letter" },
  { value: "account", label: "Account, credits, or billing" },
  { value: "other", label: "Something else" },
];

export const DESCRIPTION_MIN = 10;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const FILE_EXT = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "pptx", "zip", "rtf",
  "txt", "log", "csv", "json", "md", "har", "xml", "yaml", "yml",
]);
export const ACCEPT = [...IMAGE_EXT, ...FILE_EXT].map((e) => `.${e}`).join(",") + ",image/*";

let seq = 0;

function patch(p) {
  setState({ report: { ...state.report, ...(typeof p === "function" ? p(state.report) : p) } });
}

export function limits() {
  return { ...DEFAULT_LIMITS, ...(state.report.options || {}) };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/** Image or supported file; null when the type is not accepted. */
export function attachmentKind(file) {
  const ext = extOf(file.name);
  if ((file.type || "").startsWith("image/") && (IMAGE_EXT.has(ext) || !ext)) return "image";
  if (IMAGE_EXT.has(ext)) return "image";
  if (FILE_EXT.has(ext)) return "file";
  return null;
}

/** Pasted and captured images arrive as "image.png"; give them a name worth reading. */
function named(file, prefix) {
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
  if (!generic) return file;
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return new File([file], `${prefix} ${stamp()}.${ext}`, { type: file.type || "image/png" });
}

/**
 * Add files from an input, a drop, or a paste. Returns how many were added;
 * explains the rest in a toast.
 */
export function addFiles(list, { prefix = "Screenshot" } = {}) {
  const lim = limits();
  const files = [...state.report.files];
  let total = files.reduce((n, f) => n + f.file.size, 0);
  const problems = [];
  let added = 0;
  for (const raw of Array.from(list || [])) {
    if (!raw) continue;
    seq += 1;
    const file = named(raw, prefix);
    const kind = attachmentKind(file);
    if (!kind) {
      problems.push(`${file.name} is not a supported file type.`);
      continue;
    }
    if (!file.size) {
      problems.push(`${file.name} is empty.`);
      continue;
    }
    if (file.size > lim.max_file_bytes) {
      problems.push(`${file.name} is larger than ${formatBytes(lim.max_file_bytes)}.`);
      continue;
    }
    if (files.length >= lim.max_attachments) {
      problems.push(`You can attach up to ${lim.max_attachments} files.`);
      break;
    }
    if (total + file.size > lim.max_total_bytes) {
      problems.push(`Attachments can add up to ${formatBytes(lim.max_total_bytes)}.`);
      break;
    }
    total += file.size;
    files.push({ id: `a${seq}`, file, kind, url: kind === "image" ? URL.createObjectURL(file) : null });
    added += 1;
  }
  if (added) patch({ files, error: null });
  if (problems.length) toast([...new Set(problems)].join(" "), "danger");
  return added;
}

export function removeFile(id) {
  const gone = state.report.files.find((f) => f.id === id);
  if (gone && gone.url) URL.revokeObjectURL(gone.url);
  patch({ files: state.report.files.filter((f) => f.id !== id) });
}

/** Image files on the clipboard of a paste event. */
export function clipboardFiles(e) {
  const dt = e.clipboardData;
  if (!dt) return [];
  const fromItems = Array.from(dt.items || [])
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter(Boolean);
  return fromItems.length ? fromItems : Array.from(dt.files || []);
}

export function setDraft(p) {
  patch({ ...p, error: null });
}

const CAPTURE_PERMISSION = { origins: ["<all_urls>"] };

async function dataUrlToFile(dataUrl, name) {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type || "image/png" });
}

/** Screenshot of what the work tab shows right now. */
export async function captureTab() {
  if (state.report.capturing) return;
  patch({ capturing: true });
  try {
    const tab = await getWebWorkTab();
    if (!tab) {
      toast("Open the page with the problem in a browser tab, then capture it.", "info");
      return;
    }
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    } catch {
      // Chrome only captures with activeTab or <all_urls>; access to the one site is not enough.
      const granted = await chrome.permissions.request(CAPTURE_PERMISSION).catch(() => false);
      if (!granted) {
        toast("NAO needs access to your tabs to capture the page. Paste or upload a screenshot instead.", "danger");
        return;
      }
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    }
    const host = new URL(tab.url).hostname.replace(/^www\./, "");
    const file = await dataUrlToFile(dataUrl, `Screenshot ${host} ${stamp()}.png`);
    if (addFiles([file])) toast("Screenshot of the page added.", "ok");
  } catch {
    toast("Could not capture this page. Paste or upload a screenshot instead.", "danger");
  } finally {
    patch({ capturing: false });
  }
}

/** Show the report form, remembering where the person came from. */
export async function openReport(showView) {
  const job = state.job;
  const origin = {
    view: state.view,
    job_id: job ? job.job_id : null,
    job_title: job ? job.title : null,
    company: job ? job.company : null,
  };
  patch({ origin, sent: null, error: null });
  // Over a job, keep the job and its autofill alive so Back returns to them.
  if (state.view === "job") setState({ view: "report" });
  else await showView("report");
  void refreshPage();
  void loadOptions();
  void loadMine();
}

export async function refreshPage() {
  try {
    const tab = await getWebWorkTab();
    patch({ page: tab ? { url: tab.url, title: tab.title || "" } : null });
  } catch {
    patch({ page: null });
  }
}

async function loadOptions() {
  if (state.report.options) return;
  try {
    patch({ options: await api.getIssueOptions() });
  } catch {
    /* defaults still apply */
  }
}

export async function loadMine() {
  patch({ mineLoading: true });
  try {
    const data = await api.listMyIssues(10);
    patch({ mine: (data && data.items) || [], mineLoading: false });
  } catch {
    patch({ mineLoading: false });
  }
}

function context() {
  const r = state.report;
  const origin = r.origin || {};
  return {
    extension_version: chrome.runtime.getManifest().version,
    user_agent: navigator.userAgent,
    language: navigator.language,
    screen: `${window.screen.width}x${window.screen.height}`,
    panel_view: origin.view || null,
    job_id: origin.job_id || null,
    job_title: origin.job_title || null,
    company: origin.company || null,
    server: state.backendUrl || null,
  };
}

export async function submitReport() {
  const r = state.report;
  if (r.sending) return false;
  if (r.description.trim().length < DESCRIPTION_MIN) {
    patch({ error: "Describe what happened in a few words (at least 10 characters)." });
    return false;
  }
  patch({ sending: true, error: null });
  try {
    const page = r.includePage && r.page ? r.page : null;
    const sent = await api.submitIssue({
      category: r.category,
      title: r.title.trim(),
      description: r.description.trim(),
      page_url: page ? page.url : "",
      page_title: page ? page.title : "",
      context: context(),
      files: r.files.map((f) => f.file),
      source: "extension",
    });
    for (const f of r.files) if (f.url) URL.revokeObjectURL(f.url);
    patch({ ...emptyReport(), options: r.options, page: r.page, origin: r.origin, sent, mine: r.mine });
    void loadMine();
    return true;
  } catch (err) {
    patch({ sending: false, error: messageOf(err, "Could not send the report. Try again.") });
    return false;
  }
}

export function startAnother() {
  patch({ sent: null });
}
