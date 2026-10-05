// HTTP client for the NAO backend. Authenticates with the long-lived Bearer
// token from /auth/login, never the dashboard cookie: Chrome can attach that
// cookie to extension fetches, and an expired one would 401 a valid request.

import { clearToken, getBackendUrl, getToken, setCurrentUser, setToken } from "./storage.js";

const API_PREFIX = "/api/v1";
const DEFAULT_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status, or 0 for network / timeout failures
   * @param {"network"|"timeout"|"auth"|"http"} kind
   */
  constructor(message, status, kind = "http") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
  }
}

let unauthorizedHandler = null;

/**
 * Called once when a request with a token attached is refused for the account
 * itself (expired, revoked, disabled, or not approved). Receives the reason to
 * show, or null for a plain expiry.
 */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

async function handleUnauthorized(message = null) {
  await clearToken();
  if (unauthorizedHandler) unauthorizedHandler(message);
}

/** Request the optional host permission for the server origin (needs a user gesture). */
export async function ensureHostPermission(backendUrl) {
  try {
    const u = new URL(backendUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const origins = [`${u.origin}/*`];
    if (await chrome.permissions.contains({ origins })) return true;
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

function errorDetail(data, fallback) {
  const detail = data && typeof data === "object" ? data.detail : null;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0];
    if (typeof first === "string") return first;
    if (first && first.msg) return String(first.msg);
  }
  if (typeof data === "string" && data.trim() && data.length < 300) return data.trim();
  return fallback;
}

async function hostLabel() {
  try {
    return new URL(await getBackendUrl()).host;
  } catch {
    return "the server";
  }
}

/**
 * Low-level fetch with auth, timeout and uniform errors. Returns the Response.
 * @param {string} path API path below /api/v1
 * @param {{ method?: string, body?: any, auth?: boolean, timeoutMs?: number, signal?: AbortSignal, accept?: string }} [opts]
 */
async function send(path, { method = "GET", body, auth = true, timeoutMs = DEFAULT_TIMEOUT_MS, signal, accept } = {}) {
  const base = await getBackendUrl();
  const headers = {};
  if (accept) headers.Accept = accept;
  if (auth) {
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), timeoutMs) : null;

  try {
    return await fetch(`${base}${API_PREFIX}${path}`, {
      method,
      headers,
      body: payload,
      credentials: "omit",
      signal: ctrl.signal,
    });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    if (ctrl.signal.aborted) {
      throw new ApiError(`${await hostLabel()} took too long to respond. Try again.`, 0, "timeout");
    }
    throw new ApiError(`Can't reach ${await hostLabel()}. Check your connection or the server address in Settings.`, 0, "network");
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function checkStatus(res, auth) {
  if (res.ok) return;
  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  // The server sets X-Auth-Status when the account's signup is pending or was declined.
  const accountState = res.headers.get("x-auth-status");
  if (res.status === 401) {
    if (auth) {
      const reason = accountState ? errorDetail(data, null) : null;
      await handleUnauthorized(reason);
      throw new ApiError(reason || "Your session expired. Sign in again.", 401, "auth");
    }
    throw new ApiError(errorDetail(data, "Incorrect email or password."), 401, "auth");
  }
  if (res.status === 403 && accountState) {
    const reason = errorDetail(data, "This account is not approved yet.");
    if (auth) await handleUnauthorized(reason);
    throw new ApiError(reason, 403, "auth");
  }
  throw new ApiError(errorDetail(data, `Request failed (${res.status}).`), res.status, "http");
}

export async function apiFetch(path, opts = {}) {
  const auth = opts.auth !== false;
  const res = await send(path, opts);
  await checkStatus(res, auth);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const qs = (params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    q.set(k, v === true ? "true" : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
};

// ── auth ─────────────────────────────────────────────────────────────────────

export async function login(email, password) {
  await clearToken();
  const data = await apiFetch("/auth/login", {
    method: "POST",
    body: { email, password, long_lived: true },
    auth: false,
  });
  if (!data || !data.access_token) throw new ApiError("Sign in did not return a session. Update the server.", 500);
  await setToken(data.access_token);
  const user = { user_id: data.user_id, email: data.email };
  await setCurrentUser(user);
  return user;
}

/** Revoke the token on the server (best effort, so sign-out works offline), then forget it. */
export async function logout() {
  if (await getToken()) {
    try {
      const res = await send("/auth/logout", { method: "POST", timeoutMs: 5000 });
      await res.body?.cancel();
    } catch {
      /* offline or server down: the local sign-out still happens */
    }
  }
  await clearToken();
}

/** WebSocket URL for live events (token in the query string, as the dashboard does). */
export async function liveEventsUrl() {
  const [base, token] = await Promise.all([getBackendUrl(), getToken()]);
  if (!token) return null;
  return `${base.replace(/^http/i, "ws")}${API_PREFIX}/ws?token=${encodeURIComponent(token)}`;
}

// ── account ──────────────────────────────────────────────────────────────────

export const getProfile = () => apiFetch("/profile");
export const getProfileText = () => apiFetch("/profile/openai-text");
export const getSettings = () => apiFetch("/settings");
export const updateSettings = (body) => apiFetch("/settings", { method: "PUT", body });
export const getDataVersion = () => apiFetch("/me/data-version");

// ── home + lists ─────────────────────────────────────────────────────────────

export const getHome = (timezone) => apiFetch(`/extension/home${qs({ timezone })}`);
export const getRevision = () => apiFetch("/extension/revision", { timeoutMs: 10_000 });

/**
 * @param {{ view?: string, page?: number, per_page?: number, sort?: string, order?: string, q?: string,
 *   source?: string, remote_only?: boolean, min_match_score?: number, timezone?: string }} params
 */
export const getJobs = (params = {}, { signal } = {}) =>
  apiFetch(
    `/jobs/dashboard${qs({
      page: params.page || 1,
      per_page: params.per_page || 25,
      sort: params.sort || "created_at",
      order: params.order || "desc",
      view: params.view || "all",
      q: params.q,
      source: params.source,
      remote_only: params.remote_only,
      min_match_score: params.min_match_score || undefined,
      timezone: params.timezone,
    })}`,
    { signal }
  );

export const getWeeklyProgress = ({ days = 7, timezone } = {}) =>
  apiFetch(`/jobs/dashboard/weekly-progress${qs({ days, timezone })}`);

export const getScraperStats = (timezone) => apiFetch(`/scraper/stats${qs({ timezone })}`);

// ── applications ─────────────────────────────────────────────────────────────

export const listSessions = (status, limit = 100) => apiFetch(`/assistant/sessions${qs({ status, limit })}`);
export const openSession = (jobId, { fresh = true } = {}) =>
  apiFetch(`/assistant/sessions/${encodeURIComponent(jobId)}/open`, { method: "POST", body: { fresh } });
export const getSessionDocs = (jobId) => apiFetch(`/assistant/sessions/${encodeURIComponent(jobId)}/docs`);
export const updateSession = (jobId, status) =>
  apiFetch(`/assistant/sessions/${encodeURIComponent(jobId)}`, { method: "PATCH", body: { status } });

export const nextJob = (after, { view, remote_only, min_match_score, timezone } = {}) =>
  apiFetch(`/assistant/next-job${qs({ after, view, remote_only, min_match_score: min_match_score || undefined, timezone })}`);

export const markApplied = (jobIds) =>
  apiFetch("/jobs/valid/applied/batch", { method: "POST", body: { job_ids: jobIds } });

export const reportJobInvalid = (jobId, reason) =>
  apiFetch(`/jobs/valid/${encodeURIComponent(jobId)}/report-invalid`, {
    method: "POST",
    body: { duplication_reason: reason },
  });

export const triggerMatch = (jobId) => apiFetch(`/jobs/valid/${encodeURIComponent(jobId)}/match`, { method: "POST" });

export const postJobsToPumble = (jobIds) =>
  apiFetch("/pumble/post-jobs", { method: "POST", body: { job_ids: jobIds }, timeoutMs: 60_000 });

export const submitJobUrl = (url) => apiFetch("/jobs/submit", { method: "POST", body: { url } });

// ── autofill ─────────────────────────────────────────────────────────────────

/** fields: per-control specs -> { results: [{ handle, controls: [{ cid, value, ... }] }] } */
export const autofill = (jobId, fields, preferences) =>
  apiFetch("/assistant/autofill", {
    method: "POST",
    body: { job_id: jobId, fields, ...(preferences ? { preferences } : {}) },
    timeoutMs: 180_000,
  });

/** Canonical structured profile for deterministic engines (Workday) and cover letters. */
export const getAutofillProfile = (jobId, resumeSource = "original") =>
  apiFetch(`/assistant/autofill-profile${qs({ job_id: jobId, resume_source: resumeSource })}`, { timeoutMs: 45_000 });

/**
 * Generated resume / cover letter as base64, for page file inputs and downloads.
 * @param {"resume_pdf"|"resume_docx"|"cover_letter_pdf"|"cover_letter_docx"} fileType
 */
export async function downloadResumeFile(jobId, fileType) {
  const res = await send(`/jobs/valid/${encodeURIComponent(jobId)}/resume-build/download/${fileType}`, {
    timeoutMs: 60_000,
  });
  await checkStatus(res, true);
  const buf = await res.arrayBuffer();
  if (!buf || buf.byteLength < 8) throw new ApiError("The file is empty.", 500);
  const bytes = new Uint8Array(buf);
  const isPdf = fileType.endsWith("_pdf");
  if (isPdf && String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
    throw new ApiError("The server did not return a PDF. Sign in again and retry.", 500);
  }
  return {
    base64: bytesToBase64(bytes),
    filename: filenameFromDisposition(res.headers.get("Content-Disposition"), `${fileType}${isPdf ? ".pdf" : ".docx"}`),
    mime: isPdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}

export function filenameFromDisposition(header, fallback) {
  const disp = header || "";
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(disp);
  if (star) {
    const raw = star[1].trim().replace(/["']/g, "");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^";]+)/i.exec(disp);
  return plain ? (plain[1] || plain[2]).trim() : fallback;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ── resume library / tailoring ───────────────────────────────────────────────

export const searchResumeLibrary = ({ company, job_title, limit = 100 } = {}) =>
  apiFetch(`/resume-builder/resumes/search${qs({ company, job_title, limit })}`);
export const saveAiTailoredResume = ({ content, job_title, company, activate = true }) =>
  apiFetch("/resume-builder/resumes/from-ai-content", { method: "POST", body: { content, job_title, company, activate } });
export const openJobBuildResume = (buildId) =>
  apiFetch(`/resume-builder/resumes/from-job-build/${encodeURIComponent(buildId)}`, { method: "POST" });
export const activateResume = (resumeId) =>
  apiFetch(`/resume-builder/resumes/${encodeURIComponent(resumeId)}/activate`, { method: "POST" });
export const triggerResumeBuild = (jobId) =>
  apiFetch(`/jobs/valid/${encodeURIComponent(jobId)}/resume-build/trigger`, { method: "POST" });

// ── streaming (SSE over fetch so the Authorization header can be sent) ───────

/** Reads a `data:` SSE stream and calls onEvent with each parsed JSON frame. */
export async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (raw) => {
    const data = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) return;
    try {
      onEvent(JSON.parse(data));
    } catch {
      /* ignore malformed frames */
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      flush(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) flush(buffer);
}

async function openStream(path, body, signal) {
  const res = await send(path, { method: "POST", body, signal, timeoutMs: 0, accept: "text/event-stream" });
  await checkStatus(res, true);
  if (!res.body) throw new ApiError("The server sent an empty response.", res.status);
  return res;
}

/**
 * Job assistant chat. Resolves when the stream ends; throws ApiError on failure
 * and AbortError when `signal` is aborted.
 */
export async function chatStream(reqBody, { onDelta, signal }) {
  const res = await openStream("/assistant/chat", reqBody, signal);
  let error = null;
  await readSse(res, (frame) => {
    if (frame.delta) onDelta(frame.delta);
    if (frame.error) error = frame.error;
  });
  if (error) throw new ApiError(String(error), 500);
}

/** Resume Builder AI tailor stream: reports stages, resolves with the final result. */
export async function streamResumeAiChat(messages, lastJobDescription, { onStage, signal } = {}) {
  const res = await openStream("/resume-builder/ai/chat", { messages, last_job_description: lastJobDescription }, signal);
  let result = null;
  let error = null;
  await readSse(res, (frame) => {
    if (frame.stage === "done" && frame.result) result = frame.result;
    else if (frame.stage === "error") error = frame.message || "Tailoring failed.";
    else if (frame.stage && onStage) onStage({ stage: frame.stage, label: frame.label });
  });
  if (error) throw new ApiError(error, 500);
  if (!result) throw new ApiError("Tailoring returned no result.", 500);
  return result;
}
