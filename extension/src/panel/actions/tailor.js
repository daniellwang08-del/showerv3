// Tailored resumes: paste a job description, build for a pooled job, and
// browse the resume library.

import * as api from "../../api.js";
import * as storage from "../../storage.js";
import { messageOf } from "../format.js";
import { setState, state } from "../state.js";
import { openNewTab } from "../tabs.js";
import { toast } from "../toast.js";
import { openJob } from "./job.js";

export const MIN_DESCRIPTION_CHARS = 80;

function patchRun(id, patch) {
  setState({ tailor: { ...state.tailor, runs: state.tailor.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)) } });
}

function addRun(run) {
  setState({ tailor: { ...state.tailor, runs: [run, ...state.tailor.runs.filter((r) => r.id !== run.id)] } });
}

export function setTailorTab(tab) {
  setState({ tailor: { ...state.tailor, tab } });
  if (tab === "library" && !state.tailor.library) void loadLibrary();
}

/** Tailor the active resume to a pasted job description and save it. */
export async function tailorFromDescription(description) {
  const text = String(description || "").trim();
  if (text.length < MIN_DESCRIPTION_CHARS) {
    toast("Paste the full job description. That looks too short.", "warn");
    return false;
  }
  if (state.tailor.runs.some((r) => r.kind === "manual" && r.status === "running")) {
    toast("A tailored resume is already being written.", "warn");
    return false;
  }
  const id = `manual-${Date.now()}`;
  addRun({ id, kind: "manual", title: "Pasted job description", company: null, label: "Reading the description", status: "running" });
  try {
    const result = await api.streamResumeAiChat([{ role: "user", content: text }], null, {
      onStage: (ev) => patchRun(id, { label: ev.label || ev.stage || "Working" }),
    });
    if (result.action !== "tailored" || !result.content) {
      patchRun(id, { status: "error", label: result.reply || "No tailored resume came back. Try again." });
      return true;
    }
    patchRun(id, { label: "Saving to your library", title: result.job_title || "Tailored resume", company: result.company || null });
    const saved = await api.saveAiTailoredResume({
      content: result.content,
      job_title: result.job_title || null,
      company: result.company || null,
      activate: true,
    });
    const resume = (saved && saved.resume) || {};
    patchRun(id, {
      status: "done",
      label: "Saved and set as active",
      title: resume.job_title || result.job_title || "Tailored resume",
      company: resume.company || result.company || null,
      resumeId: resume.id || null,
    });
    toast("Tailored resume saved to your library.", "ok");
    setState({ tailor: { ...state.tailor, library: null } });
    return true;
  } catch (err) {
    patchRun(id, { status: "error", label: messageOf(err, "Tailoring failed.") });
    return true;
  }
}

/** Queue a tailored resume build for a job in the pool. */
export async function buildForJob(job) {
  if (!job || !job.id) return;
  const id = `job-${job.id}`;
  if (state.tailor.runs.some((r) => r.id === id && r.status === "running")) return;
  addRun({ id, kind: "job", jobId: job.id, title: job.title, company: job.company, label: "Queued", status: "running" });
  try {
    await api.triggerResumeBuild(job.id);
    patchRun(id, { status: "done", label: "Building. It moves to Ready to apply when done." });
    toast(`Building a resume for ${job.title}.`, "ok");
  } catch (err) {
    patchRun(id, { status: "error", label: messageOf(err, "Could not start the build.") });
    toast(messageOf(err, "Could not start the build."), "danger");
  }
}

export function clearFinishedRuns() {
  setState({ tailor: { ...state.tailor, runs: state.tailor.runs.filter((r) => r.status === "running") } });
}

export async function loadLibrary(query = "") {
  setState({ tailor: { ...state.tailor, libraryLoading: true } });
  try {
    const q = String(query || "").trim();
    const res = await api.searchResumeLibrary({ company: q || undefined, limit: 100 });
    let hits = (res && res.resumes) || [];
    if (q) {
      const byTitle = await api.searchResumeLibrary({ job_title: q, limit: 100 }).catch(() => null);
      const seen = new Set(hits.map((h) => h.id));
      for (const h of (byTitle && byTitle.resumes) || []) if (!seen.has(h.id)) hits.push(h);
    }
    hits = hits.filter((h) => h.content_ready !== false);
    hits.sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
    setState({ tailor: { ...state.tailor, library: hits, libraryLoading: false } });
  } catch (err) {
    setState({ tailor: { ...state.tailor, libraryLoading: false } });
    toast(messageOf(err, "Could not load your resumes."), "danger");
  }
}

export async function openStudio() {
  const base = await storage.getBackendUrl();
  await openNewTab(`${base}/app/studio`);
}

/** Make a library resume active and open it in the studio. */
export async function openLibraryResume(hit) {
  try {
    const buildId = hit.build_id || (hit.kind === "job_build" ? hit.id : null);
    if (hit.kind === "job_build" || hit.source === "job_workflow") {
      if (buildId) await api.openJobBuildResume(buildId);
      else if (hit.job_id) return openJob(hit.job_id, { navigate: true, context: null });
    } else {
      await api.activateResume(hit.id);
    }
    await openStudio();
  } catch (err) {
    toast(messageOf(err, "Could not open this resume."), "danger");
  }
}
