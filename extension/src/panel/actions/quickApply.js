// Quick apply: a job from its description alone, for postings NAO cannot
// scrape (LinkedIn and other closed sites). The server scores it and writes
// the documents the account's resume setting calls for; the job then opens
// like any other, with autofill and the assistant.

import * as api from "../../api.js";
import { isPastedJobUrl, messageOf } from "../format.js";
import { readJobPostingInPage } from "../pageJob.js";
import { emptyQuickApply, setState, state } from "../state.js";
import { getWebWorkTab } from "../tabs.js";
import { toast } from "../toast.js";
import { openJob } from "./job.js";

export const MIN_DESCRIPTION_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 60_000;

function patch(p) {
  setState({ quickApply: { ...state.quickApply, ...p } });
}

export function updateQuickApply(p) {
  patch({ ...p, error: null });
}

/** A tab URL worth keeping as the posting link: a web page that is not NAO itself. */
export function postingUrlFromTab(tabUrl, backendUrl) {
  const url = String(tabUrl || "");
  if (!/^https?:\/\//i.test(url) || isPastedJobUrl(url)) return "";
  try {
    const host = new URL(url).host;
    if (backendUrl && host === new URL(backendUrl).host) return "";
    if (/(^|\.)nao\.it\.com$/i.test(host)) return "";
  } catch {
    return "";
  }
  return url;
}

export async function openQuickApply() {
  patch({ open: true, error: null });
  if (state.quickApply.url) return;
  try {
    const tab = await getWebWorkTab();
    const url = postingUrlFromTab(tab && tab.url, state.backendUrl);
    if (url && !state.quickApply.url) patch({ url });
  } catch {
    /* no usable tab */
  }
}

export function closeQuickApply() {
  setState({ quickApply: emptyQuickApply() });
}

/** Fill the form from the posting open in the work tab. */
export async function readFromTab() {
  if (state.quickApply.reading) return;
  const tab = await getWebWorkTab().catch(() => null);
  if (!tab) {
    toast("Open the job posting in this window first.", "warn");
    return;
  }
  patch({ reading: true, error: null });
  try {
    const origins = [`${new URL(tab.url).origin}/*`];
    if (!(await chrome.permissions.contains({ origins })) && !(await chrome.permissions.request({ origins }))) {
      toast("Allow access to this site so NAO can read the posting.", "warn");
      return;
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readJobPostingInPage,
      args: [MAX_DESCRIPTION_CHARS],
    });
    const found = res && res.result;
    if (!found || String(found.description || "").trim().length < MIN_DESCRIPTION_CHARS) {
      toast("No job description found on this page. Select it and try again, or paste it.", "warn");
      return;
    }
    const q = state.quickApply;
    patch({
      description: found.description,
      title: found.title || q.title,
      company: found.company || q.company,
      url: postingUrlFromTab(found.url, state.backendUrl) || q.url,
      details: true,
    });
    toast(found.source === "selection" ? "Read your selection." : "Read the job description from this page.", "ok");
  } catch (err) {
    toast(messageOf(err, "Could not read this page."), "danger");
  } finally {
    patch({ reading: false });
  }
}

export async function submitQuickApply() {
  const q = state.quickApply;
  if (q.busy) return;
  const description = q.description.trim();
  if (description.length < MIN_DESCRIPTION_CHARS) {
    patch({ error: "Paste the full job description, at least a few sentences." });
    return;
  }
  patch({ busy: true, error: null });
  try {
    const res = await api.quickApply({
      description,
      url: q.url.trim() || null,
      title: q.title.trim() || null,
      company: q.company.trim() || null,
    });
    setState({ quickApply: emptyQuickApply() });
    toast(res.reused ? "Already in your pool. Opening it." : "Job added. Scoring it and writing your documents.", "ok");
    const jobId = String(res.job_id);
    await openJob(jobId, {
      analyzing: res.analysis === "queued",
      // "Applied, next" comes back home for the next paste instead of walking a list.
      context: { listId: "quick", title: "Quick apply", query: null, ids: [jobId], page: 1, pages: 1, seen: [] },
    });
  } catch (err) {
    patch({ busy: false, error: messageOf(err, "Could not add this job.") });
  }
}
