// Workday: deterministic multi-step engine driven from the panel. The panel owns
// the loop because only it can focus the tab (to flush deferred page commits)
// and run the LLM recovery round trip between steps.

import * as api from "../../api.js";
import { handleApplicationSubmitted } from "../actions/job.js";
import { toast } from "../toast.js";
import { emptyAutofill, setAutofill, setState, state } from "../state.js";
import { autofillChunked } from "./form.js";
import { wdStepLabel } from "./labels.js";
import {
  buildPreferences,
  debugLog,
  delay,
  getAutofillProfile,
  tabBroadcast,
  tabSend,
} from "./shared.js";

// Resolves the auto-advance loop's per-step wait when the page reports WD_DONE.
let wdStepWaiter = null;
// Monotonic seq for WD_RUN / WD_ABORT so Stop invalidates in-flight work.
let wdRunSeq = 0;

// The Workday engine asks us to resolve option values it cannot decide locally
// (e.g. map the candidate's profile degree to the dropdown's exact options). We
// reuse the LLM autofill endpoint (profile + job aware, option-snapped) and send
// the chosen option(s) back to the page, keyed by the control id. Always replies
// (even with {}) so the engine's await never hangs.
async function handleWorkdayResolve(msg) {
  const af = state.autofill;
  const job = state.job;
  const tabId = af && af.tabId;
  const reply = (values) => {
    if (tabId == null) return;
    try {
      chrome.tabs.sendMessage(tabId, { type: "WD_RESOLVE_RESULT", requestId: msg.requestId, values: values || {} });
    } catch {
      /* tab may be gone */
    }
  };
  // Backend AutofillControlIn.label / AutofillFieldIn.label max_length=600
  // (app/api/assistant_routes.py). Stuffing portal option keys into the label
  // (race/ethnicity, long Acknowledgment) caused string_too_long and empty
  // WD_RESOLVE replies, fields never filled, auto-advance then Save'd blank.
  const CONTROL_LABEL_MAX = 600;
  const clip = (s, n) => {
    const t = String(s || "")
      .replace(/\s+/g, " ")
      .trim();
    if (t.length <= n) return t;
    return t.slice(0, Math.max(0, n - 1)) + "…";
  };
  const buildControlLabel = (rawLabel, want, hasOptions) => {
    // Options + data-values live in portal HTML / options[]; keep label short.
    const suffix = hasOptions
      ? " [Reply with option data-value OR exact option text from the list/HTML]"
      : "";
    const wantPart = want ? ` (candidate: ${clip(want, 80)})` : "";
    const budget = CONTROL_LABEL_MAX - suffix.length - wantPart.length;
    const head = clip(rawLabel || "Field", Math.max(40, budget));
    return clip(head + wantPart + suffix, CONTROL_LABEL_MAX);
  };
  try {
    const items = Array.isArray(msg.items) ? msg.items : [];
    if (!job || !job.job_id || !items.length) {
      debugLog("[workday] WD_RESOLVE skipped:", {
        hasJob: !!job,
        jobId: job && job.job_id,
        itemCount: items.length,
      });
      return reply({});
    }
    const norm = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    // Build DOM-with-options html (same contract as Greenhouse extractRegionDom):
    // <ul data-af-options-for="cid"><li id data-value>text</li>…
    // Full question text + option ids/values go HERE (html max 200000), not in label.
    const htmlParts = [];
    const controls = items.map((it) => {
      const portalOptions = Array.isArray(it.portalOptions) ? it.portalOptions : [];
      // Country Phone Code ~249 rows; How Did You Hear can be 50–100+ leaves.
      // Keep headroom so the full harvested list reaches the model.
      const isPhoneCc = /country phone code/i.test(it.label || "");
      const isSource =
        !!(it.isSource || it.sourceHierarchical) ||
        /how did you hear|how.*hear about/i.test(it.label || "") ||
        /^source$/i.test(String(it.key || ""));
      const isSkills =
        !!it.isSkills ||
        /type to add skills|add skills|^skills$/i.test(it.label || "") ||
        /^skills$/i.test(String(it.key || ""));
      const optCap = isPhoneCc || isSource ? 280 : 120;
      const rawOptions = Array.isArray(it.options)
        ? it.options
        : portalOptions.map((o) => o.text).filter(Boolean);
      const optionTexts = rawOptions.map((t) => clip(t, 500)).slice(0, optCap);
      // Prefer full portal list in HTML (source of truth for the model).
      const portalForHtml =
        portalOptions.length > optCap ? portalOptions.slice(0, optCap) : portalOptions;
      let portalHtml = it.portalHtml || "";
      if (!portalHtml && portalForHtml.length) {
        const lis = portalForHtml
          .map((o) => {
            const id = String(o.id || o.value || "").replace(/"/g, "");
            const val = String(o.value || o.id || "").replace(/"/g, "");
            const text = String(o.text || "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
            return `<li id="${id}" data-value="${val}" data-af-option-id="${id}" data-af-option-value="${val}">${text}</li>`;
          })
          .join("");
        portalHtml = `<div data-af-wd-field><label>${String(it.label || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")}</label><ul data-af-options-for="${it.cid}">${lis}</ul></div>`;
      } else if (portalHtml && it.label && !/<label[\s>]/i.test(portalHtml)) {
        // Ensure the full (uncapped) question is available in HTML for the model.
        const esc = String(it.label || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;");
        portalHtml = `<div data-af-wd-field><label>${esc}</label>${portalHtml}</div>`;
      }
      if (portalHtml) htmlParts.push(portalHtml);
      const label = buildControlLabel(it.label, it.want, optionTexts.length > 0 || portalOptions.length > 0);
      if (label.length > CONTROL_LABEL_MAX) {
        console.warn("[workday] WD_RESOLVE label still over cap after clip", label.length, it.cid);
      }
      try {
        debugLog("[workday] WD_RESOLVE → LLM control", {
          cid: it.cid,
          key: it.key || null,
          isSource: !!isSource,
          want: it.want || null,
          optionsSent: optionTexts.length,
          optionsHarvested: rawOptions.length,
          portalSent: portalForHtml.length,
          truncated: rawOptions.length > optionTexts.length || portalOptions.length > portalForHtml.length,
          optionSample: optionTexts.slice(0, 8),
          labelHead: String(label || "").slice(0, 100),
        });
      } catch {}
      return {
        cid: String(it.cid).slice(0, 256),
        kind: String(it.kind || "select").slice(0, 30),
        label,
        // Pass through the real required flag. Optional fields must still be
        // answered by the shared autofill prompt when answerable.
        required: !!it.required,
        // Skills typeahead: multi=true so the model returns option_values[].
        multi: !!isSkills,
        options: optionTexts,
      };
    });

    const resp = await autofillChunked(
      job.job_id,
      [
        {
          handle: 0,
          label: clip("Workday fields", CONTROL_LABEL_MAX),
          html: htmlParts.join("\n").slice(0, 180000),
          controls,
        },
      ],
      buildPreferences(),
    );
    const isPhoneCcItem = (src, label) =>
      /country phone code/i.test((src && src.label) || "") || /country phone code/i.test(label || "");
    const isPhoneNumItem = (src, label) => {
      const L = `${(src && src.label) || ""} ${label || ""}`;
      return /phone number/i.test(L) && !/country phone code/i.test(L);
    };
    const nationalPhoneDigits = (phone) => {
      let d = String(phone || "").replace(/\D/g, "");
      if (!d) return "";
      if (d.length === 10) return d;
      if (d.length === 11 && d.charAt(0) === "1") return d.slice(1);
      if (d.charAt(0) === "1" && d.length > 11) return d.slice(1, 11);
      if (d.length > 10) return d.slice(0, 10);
      return d;
    };

    const values = {};
    const rawByCid = {};
    for (const f of (resp && resp.results) || []) {
      for (const c of f.controls || []) {
        rawByCid[c.cid] = {
          value: c.value || null,
          option: c.option || null,
          needs_user: !!c.needs_user,
          reason: c.reason || null,
        };
        if (c.needs_user) continue;
        const src = items.find((it) => String(it.cid) === String(c.cid));
        const isSkillsCtrl =
          !!(src && src.isSkills) ||
          /type to add skills|add skills|^skills$/i.test((src && src.label) || "") ||
          /type to add skills|add skills|^skills$/i.test(c.label || "") ||
          /^skills$/i.test(String((src && src.key) || ""));

        // Skills: prefer option_values[] (multi typeahead, no harvested list).
        // Cap at 10, job needs a focused set, not the full profile dump (Fiserv AA).
        if (isSkillsCtrl) {
          const fromArr = Array.isArray(c.option_values)
            ? c.option_values.map((x) => String(x || "").trim()).filter(Boolean)
            : [];
          let tokens = fromArr;
          if (!tokens.length) {
            const blob = c.option || c.value || "";
            tokens = String(blob)
              .split(/[,;\n|/]+/)
              .map((x) => x.trim())
              .filter(Boolean);
          }
          if (tokens.length) values[c.cid] = tokens.slice(0, 10);
          continue;
        }

        let v = c.option || c.value;
        if (!c.cid || !v) continue;
        const portalOptions = (src && src.portalOptions) || [];
        const opts = src && Array.isArray(src.options) ? src.options : portalOptions.map((o) => o.text);
        const phoneCc = isPhoneCcItem(src, c.label);
        const phoneNum = isPhoneNumItem(src, c.label);

        // Phone Number: format cleanup only (10 national digits).
        if (phoneNum) {
          const digits = nationalPhoneDigits(v);
          if (digits) values[c.cid] = digits;
          continue;
        }

        const want = norm(v);
        // Bare "+1"/"1" is not an exact option, do not soft-snap to Anguilla.
        if (phoneCc && (want === "1" || want === "+1")) {
          debugLog("[workday] WD_RESOLVE phone CC not exact option", c.cid, v);
          continue;
        }

        // Exact portal id / data-value / text. Prefer visible TEXT for non-phone
        // so page-side snapToHarvestedOption matches option labels (LinkedIn).
        if (portalOptions.length) {
          const byVal = portalOptions.find((o) => norm(o.value) === want || norm(o.id) === want);
          if (byVal) {
            values[c.cid] = phoneCc
              ? byVal.value || byVal.id || byVal.text
              : byVal.text || byVal.value || byVal.id;
            continue;
          }
          const byText = portalOptions.find((o) => norm(o.text) === want);
          if (byText) {
            values[c.cid] = phoneCc
              ? byText.value || byText.id || byText.text
              : byText.text || byText.value || byText.id;
            continue;
          }
          if (phoneCc) {
            debugLog("[workday] WD_RESOLVE phone CC no exact match", c.cid, v);
            continue;
          }
          const soft = portalOptions.find((o) => norm(o.text).includes(want) || want.includes(norm(o.text)));
          if (soft) {
            values[c.cid] = soft.text || soft.value || soft.id;
            continue;
          }
        }

        if (opts.length) {
          const exact = opts.find((o) => norm(o) === want);
          if (exact) {
            values[c.cid] = exact;
            continue;
          }
          if (phoneCc) {
            debugLog("[workday] WD_RESOLVE phone CC not in options", c.cid, v);
            continue;
          }
          const contains = opts
            .filter((o) => {
              const t = norm(o);
              return t.includes(want) || want.includes(t);
            })
            .sort((a, b) => a.length - b.length);
          if (contains.length) {
            values[c.cid] = contains[0];
            continue;
          }
          debugLog("[workday] WD_RESOLVE answer not in options", c.cid, v, opts.slice(0, 6));
          continue;
        }
        values[c.cid] = v;
      }
    }
    try {
      debugLog("[workday] WD_RESOLVE ← LLM raw controls", rawByCid);
      debugLog(
        "[workday] WD_RESOLVE answered",
        Object.keys(values).length,
        "/",
        items.length,
        "controls",
        values
      );
    } catch {}
    try {
      aaLog("WD_RESOLVE answered", { answered: Object.keys(values).length, total: items.length });
    } catch {}
    reply(values);
  } catch (err) {
    console.warn("[workday] WD_RESOLVE failed:", (err && err.message) || err);
    try {
      aaLog("WD_RESOLVE FAILED", { error: String((err && err.message) || err).slice(0, 400) });
    } catch {}
    reply({});
  }
}

// Workday: fetch the canonical structured profile (respecting the user's
// original/tailored resume preference), optionally attach the generated resume
// file, and tell the in-page engine to fill the current step. Auto-advance is
// OFF - the user reviews and clicks Continue between steps.
export async function startWorkdayAutofill(tab, engine) {
  const job = state.job;
  if (!job || !job.job_id) {
    toast("Open a job from your list first so we know which profile to use.");
    return;
  }
  setState({ autofill: { ...emptyAutofill(), active: true, running: true, tabId: tab.id, engine } });
  // Default to the tailored resume; only use the original when explicitly chosen.
  const resumeSource = (buildPreferences() || {}).resume_source === "original" ? "original" : "tailored";

  let profile;
  try {
    profile = await getAutofillProfile(job.job_id, resumeSource);
  } catch (err) {
    setAutofill({ running: false, done: true, error: "Could not load your profile: " + ((err && err.message) || err) });
    return;
  }

  // Best-effort resume attachment (skip silently if not generated for this job).
  let resumeFile = null;
  try {
    resumeFile = await api.downloadResumeFile(job.job_id, "resume_pdf");
    debugLog("[workday] resume PDF downloaded:", (resumeFile && resumeFile.filename) || "(unnamed)", "b64=", resumeFile && resumeFile.base64 && resumeFile.base64.length);
  } catch (e) {
    console.warn("[workday] resume PDF download failed:", (e && e.message) || e);
    resumeFile = null;
    toast((e && e.message) || "Could not download the tailored resume PDF for upload.");
  }

  // Auto-advance: drive the whole flow (fill → flush → recover → Save) until the
  // Review page. Otherwise fill just the current step and hand back to the user.
  if (state.autoAdvance) {
    setAutofill({ autoLoop: true, loopStop: false, loopFinished: null });
    await autoAdvanceWorkday(tab.id, profile, resumeFile);
    return;
  }

  try {
    const runSeq = ++wdRunSeq;
    await chrome.tabs.sendMessage(tab.id, {
      type: "WD_RUN",
      profile,
      options: { autoAdvance: false, resumeFile, newAttempt: true },
      runSeq,
    });
    armWorkdayWatchdog();
  } catch (err) {
    setAutofill({ running: false, done: true, error: "Could not reach the page: " + ((err && err.message) || err) });
  }
}

// ── Workday auto-advance loop ────────────────────────────────────────────────
// Owns the multi-step flow from the side panel because only this context can
// (a) focus the tab to flush the page's deferred text/date commits and (b) run
// the LLM recovery round-trip. Per step: fill → focus-flush → validate →
// (LLM recover + re-flush if needed) → Save & Continue. Stops at Review, when
// stuck, when errors persist after recovery, or when the user hits Stop.
const WD_MAX_STEPS = 9;
// Per step: hard cap on WD_RUN fill passes (initial + recoveries). 2 = one initial
// full fill + ONE targeted recovery. Workday only surfaces most required-field
// errors AFTER "Save and Continue", so a single recovery pass is required to fix
// them. The recovery re-fills ONLY the fields Workday flagged (options.onlyInvalid),
// never the whole step, already-committed fields are left untouched, so this is
// not the "re-type everything" churn the one-pass design guarded against.
const WD_MAX_STEP_FILLS = 2;
// Per step: how many Save attempts. One targeted onlyInvalid recovery may run
// between attempts (see the loop). 3 = initial Save → recover+Save → one buffer
// Save (slow-nav / late validation UI).
const WD_MAX_SAVE_ATTEMPTS = 3;

// Wait for the page to finish a WD_RUN fill (resolved via the WD_DONE handler).
// The My Experience step can be slow (panel adds wait ~20s each + LLM matches),
// so allow generous headroom before giving up.
function waitWorkdayFill(timeoutMs = 180000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      wdStepWaiter = null;
      resolve({ timeout: true });
    }, timeoutMs);
    wdStepWaiter = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      wdStepWaiter = null;
      resolve(payload || {});
    };
  });
}

// Give the application tab real OS focus so the page's window 'focus' fires and
// flushes deferred commits, then ask the engine to flush as an explicit backstop.
async function focusPageAndFlush(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* tab/window may be gone */
  }
  await delay(450); // let the focus event settle (may still be false with side panel open)
  const flush = await tabSend(tabId, { type: "WD_FLUSH" }, 0);
  try {
    debugLog("[workday] focusPageAndFlush:", flush);
  } catch {}
  await delay(150);
}

async function fillCurrentStep(tabId, profile, resumeFile, extraOptions) {
  if (state.autofill.loopStop || !state.autofill.active) return { aborted: true };
  const runSeq = ++wdRunSeq;
  const wait = waitWorkdayFill();
  const options = { autoAdvance: false, resumeFile, ...(extraOptions || {}) };
  try {
    await tabSend(tabId, { type: "WD_RUN", profile, options, runSeq }, 0);
  } catch (err) {
    if (wdStepWaiter) wdStepWaiter({ error: (err && err.message) || String(err) });
  }
  // Stop may have resolved the waiter while tabSend was in flight.
  if (state.autofill.loopStop) {
    void tabBroadcast(tabId, { type: "WD_ABORT", minRunSeq: wdRunSeq });
  }
  return wait;
}

function workdayReallyAdvanced(fromStep, next) {
  if (!next || !next.advanced || (next && next.aborted)) return false;
  const after = next.after;
  // Prefer distinct step ids (questions_1_of_2 → questions_2_of_2).
  if (after && after !== fromStep && after !== "generic") return true;
  // Fallback: page title changed while step id stayed collapsed (legacy "questions").
  if (next.beforeHeading && next.afterHeading && next.afterHeading !== next.beforeHeading) {
    return true;
  }
  return false;
}

function aaLog(...args) {
  try {
    debugLog("[workday][AA]", ...args);
  } catch {
    /* ignore */
  }
  try {
    const line = args
      .map((a) => {
        try {
          return typeof a === "string" ? a : JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    pushAaLog("[panel] " + line);
  } catch {
    /* ignore */
  }
}

let aaLogBuffer = [];
let aaLogFlushTimer = null;

function pushAaLog(line) {
  if (!state.autofill || !state.autofill.active) return;
  aaLogBuffer.push({ t: Date.now(), line: String(line || "").slice(0, 1000) });
  if (aaLogFlushTimer) return;
  aaLogFlushTimer = setTimeout(() => {
    aaLogFlushTimer = null;
    const prev = Array.isArray(state.autofill.aaLogs) ? state.autofill.aaLogs : [];
    const next = [...prev, ...aaLogBuffer].slice(-400);
    aaLogBuffer = [];
    setAutofill({ aaLogs: next });
  }, 120);
}

async function autoAdvanceWorkday(tabId, profile, resumeFile) {
  const loopStopped = () => state.autofill.loopStop || !state.autofill.active;
  // First WD_RUN of this session clears the failed-field skip set; recoveries keep it.
  let sessionFresh = true;
  aaLog("loop start", {
    tabId,
    WD_MAX_STEPS,
    WD_MAX_STEP_FILLS,
    WD_MAX_SAVE_ATTEMPTS,
    autoSubmit: !!state.autoSubmit,
  });

  // Reached the Review step. If the user enabled auto-submit (Workday only),
  // click the final Submit and confirm the thank-you page; otherwise stop at
  // Review so the user submits manually. Always ends the loop.
  const finishAtReview = async () => {
    if (!state.autoSubmit) return finishLoop("review");
    if (loopStopped()) return finishLoop("stopped");
    setAutofill({ loopStatus: "Submitting application…" });
    aaLog("phase: AUTO-SUBMIT, clicking Submit on Review", {});
    const res = await tabSend(tabId, { type: "WD_SUBMIT" }, 0);
    aaLog("WD_SUBMIT result", res || {});
    if (loopStopped() || (res && res.aborted)) return finishLoop("stopped");
    // Confirm the submission actually landed (thank-you / submitted page).
    await delay(900);
    if (loopStopped()) return finishLoop("stopped");
    const d = await tabSend(tabId, { type: "WD_DETECT" }, 0);
    const submitted = !!(res && res.submitted) || (d && d.step === "submitted");
    if (submitted) {
      finishLoop("submitted");
      await handleApplicationSubmitted({
        reason: "wd-auto-submit",
        jobId: state.job && state.job.job_id,
      });
      return;
    }
    // Submit didn't confirm, leave the user on Review to finish manually.
    aaLog("auto-submit did not confirm, leaving at Review", { res, detect: d });
    return finishLoop("review");
  };
  try {
    for (let i = 0; i < WD_MAX_STEPS; i++) {
      if (loopStopped()) return finishLoop("stopped");

      const det = await tabSend(tabId, { type: "WD_DETECT" }, 0);
      const step = det && det.step;
      aaLog("outer detect", {
        i,
        step,
        heading: det && det.heading,
        href: det && det.href,
        label: wdStepLabel(step),
      });
      if (step === "submitted") {
        finishLoop("submitted");
        await handleApplicationSubmitted({
          reason: "wd-detect-submitted",
          jobId: state.job && state.job.job_id,
        });
        return;
      }
      if (!step) return finishLoop(state.autofill.reports.length ? "done" : "none");
      if (step === "review") return finishAtReview();

      const label = wdStepLabel(step);
      let fillsUsed = 0;
      const runFill = async (extraOptions) => {
        if (loopStopped()) return { aborted: true };
        if (fillsUsed >= WD_MAX_STEP_FILLS) {
          aaLog("runFill SKIPPED, fill budget exhausted", {
            label,
            step,
            fillsUsed,
            WD_MAX_STEP_FILLS,
            onlyInvalid: extraOptions && extraOptions.onlyInvalid,
          });
          return { skipped: true };
        }
        fillsUsed += 1;
        const opts = { ...(extraOptions || {}), newAttempt: sessionFresh };
        sessionFresh = false;
        aaLog("runFill START", {
          label,
          step,
          fillsUsed,
          newAttempt: opts.newAttempt,
          onlyInvalidCount: Array.isArray(opts.onlyInvalid) ? opts.onlyInvalid.length : 0,
          onlyInvalid: opts.onlyInvalid,
        });
        const result = await fillCurrentStep(tabId, profile, resumeFile, opts);
        aaLog("runFill DONE", {
          label,
          step,
          fillsUsed,
          aborted: !!(result && result.aborted),
          skipped: !!(result && result.skipped),
          error: result && result.error,
          reports: (result && result.reports) || [],
        });
        return result;
      };

      // Initial fill of the step.
      setAutofill({ loopStatus: `Filling ${label}…` });
      aaLog("phase: INITIAL FILL", { label, step, heading: det && det.heading });
      const fill = await runFill();
      if (fill.aborted || loopStopped()) return finishLoop("stopped");
      if (fill.error) return finishLoop("error", fill.error);

      // Clear validation and advance. If validation is dirty (pre-save OR after
      // Save reveals required errors), re-fill ONLY the flagged fields
      // (options.onlyInvalid) once, bounded by WD_MAX_STEP_FILLS, then Save
      // again. Committed fields are never re-touched, so this recovers a genuinely
      // failed field without re-harvesting the whole step.
      let advanced = false;
      let lastNames = [];
      // Re-fill just the fields Workday flagged. Returns "ok" | "aborted" | "error"
      // | "skipped" (budget exhausted). Callers decide how to proceed.
      const recoverInvalid = async (invalidFields, at) => {
        if (fillsUsed >= WD_MAX_STEP_FILLS) return { status: "skipped" };
        if (!Array.isArray(invalidFields) || !invalidFields.length) return { status: "skipped" };
        aaLog("phase: RECOVERY refill invalid fields", {
          at,
          label,
          step,
          fillsUsed,
          onlyInvalid: invalidFields,
        });
        setAutofill({ loopStatus: `Fixing ${label}…` });
        const rec = await runFill({ onlyInvalid: invalidFields });
        if (rec.aborted || loopStopped()) return { status: "aborted" };
        if (rec.error) return { status: "error", error: rec.error };
        if (rec.skipped) return { status: "skipped" };
        return { status: "ok" };
      };
      for (let attempt = 0; attempt < WD_MAX_SAVE_ATTEMPTS && !advanced; attempt++) {
        if (loopStopped()) return finishLoop("stopped");
        setAutofill({ loopStatus: `Committing ${label}…` });
        await focusPageAndFlush(tabId);
        if (loopStopped()) return finishLoop("stopped");

        let v = await tabSend(tabId, { type: "WD_VALIDATE" }, 0);
        aaLog("pre-save VALIDATE", {
          attempt: attempt + 1,
          label,
          step,
          fillsUsed,
          clean: v && v.clean,
          errorCount: v && v.errorCount,
          invalidFields: v && v.invalidFields,
        });
        if (v && !v.clean) {
          lastNames = (v.invalidFields || []).map((f) => f.label || f.key).filter(Boolean);
          debugLog(`[workday] auto-advance: ${label} pre-save errors`, v.invalidFields);
          aaLog("WARN: dirty validation before Save, retrying failed fields", { label, lastNames });
          const rec = await recoverInvalid(v.invalidFields, "pre-save");
          if (rec.status === "aborted") return finishLoop("stopped");
          if (rec.status === "error") return finishLoop("error", rec.error);
          if (rec.status === "ok") {
            // Re-flush and re-validate before deciding to Save.
            await focusPageAndFlush(tabId);
            if (loopStopped()) return finishLoop("stopped");
            v = await tabSend(tabId, { type: "WD_VALIDATE" }, 0);
            aaLog("post-recovery VALIDATE (pre-save)", {
              attempt: attempt + 1,
              clean: v && v.clean,
              errorCount: v && v.errorCount,
              invalidFields: v && v.invalidFields,
            });
            if (v && !v.clean) {
              lastNames = (v.invalidFields || []).map((f) => f.label || f.key).filter(Boolean);
            }
          }
        }

        // Try to advance.
        aaLog("phase: ADVANCE click Save/Continue", {
          attempt: attempt + 1,
          label,
          step,
          fillsUsed,
          validateClean: v && v.clean,
          invalidStill: v && v.invalidFields,
        });
        setAutofill({ loopStatus: `Advancing from ${label}…` });
        const next = await tabSend(tabId, { type: "WD_NEXT" }, 0);
        aaLog("WD_NEXT result", {
          ok: next && next.ok,
          advancedFlag: next && next.advanced,
          before: next && next.before,
          after: next && next.after,
          beforeHeading: next && next.beforeHeading,
          afterHeading: next && next.afterHeading,
          reallyAdvanced: workdayReallyAdvanced(step, next),
        });
        if (loopStopped() || (next && next.aborted)) return finishLoop("stopped");
        if (workdayReallyAdvanced(step, next)) {
          // Re-detect: reject false positives from transient detectStep flips.
          const confirm = await tabSend(tabId, { type: "WD_DETECT" }, 0);
          const confirmStepOk =
            confirm && confirm.step && confirm.step !== step && confirm.step !== "generic";
          const confirmHeadingOk =
            next.afterHeading &&
            confirm &&
            confirm.heading &&
            confirm.heading === next.afterHeading &&
            next.beforeHeading &&
            confirm.heading !== next.beforeHeading;
          aaLog("advance confirm", {
            confirmStep: confirm && confirm.step,
            confirmHeading: confirm && confirm.heading,
            confirmStepOk,
            confirmHeadingOk,
          });
          if (confirmStepOk || confirmHeadingOk) {
            advanced = true;
            aaLog("ADVANCED OK → next outer step", { from: step, to: confirm && confirm.step });
            break;
          }
          debugLog(`[workday] auto-advance: ${label} false advance ignored`, next, confirm);
          aaLog("false advance ignored", { next, confirm });
        }

        // Didn't advance - re-validate; Workday likely just revealed errors on Save.
        await focusPageAndFlush(tabId);
        if (loopStopped()) return finishLoop("stopped");
        v = await tabSend(tabId, { type: "WD_VALIDATE" }, 0);
        aaLog("post-save VALIDATE", {
          attempt: attempt + 1,
          clean: v && v.clean,
          errorCount: v && v.errorCount,
          invalidFields: v && v.invalidFields,
        });
        if (v && !v.clean) {
          lastNames = (v.invalidFields || []).map((f) => f.label || f.key).filter(Boolean);
          debugLog(`[workday] auto-advance: ${label} post-save errors`, v.invalidFields);
          const rec = await recoverInvalid(v.invalidFields, "post-save");
          if (rec.status === "aborted") return finishLoop("stopped");
          if (rec.status === "error") return finishLoop("error", rec.error);
          if (rec.status === "ok") {
            // Recovery filled the flagged fields, let the next attempt re-flush,
            // re-validate, and Save again.
            aaLog("post-save recovery done, retrying Save", { lastNames, fillsUsed });
            continue;
          }
          // No budget left (or nothing to retry), surface the fields to the user.
          aaLog("WARN: post-save dirty, recovery budget exhausted; surface to user", {
            lastNames,
            fillsUsed,
          });
          break;
        } else {
          // No detectable error but it didn't move - maybe a slow navigation.
          // WD_NEXT now keeps polling through step:null; this is only a short backup.
          await delay(700);
          if (loopStopped()) return finishLoop("stopped");
          const d2 = await tabSend(tabId, { type: "WD_DETECT" }, 0);
          aaLog("slow-nav redetect", { d2 });
          if (d2 && d2.step && d2.step !== step && d2.step !== "generic") {
            advanced = true;
            break;
          }
          debugLog(`[workday] auto-advance: ${label} did not advance and no errors detected (attempt ${attempt + 1})`);
          aaLog("stuck: no advance, no errors", { attempt: attempt + 1, label, step });
        }
      }

      if (loopStopped()) return finishLoop("stopped");
      if (!advanced) {
        // Post-submit confirmation can look like a dead-end step; Complete & Next.
        const recheck = await tabSend(tabId, { type: "WD_DETECT" }, 0);
        aaLog("step FAILED to advance", { label, step, lastNames, recheck });
        if (recheck && recheck.step === "submitted") {
          finishLoop("submitted");
          await handleApplicationSubmitted({
            reason: "wd-stuck-submitted",
            jobId: state.job && state.job.job_id,
          });
          return;
        }
        if (recheck && recheck.step === "review") return finishAtReview();
        return finishLoop(
          "needs_user",
          lastNames.length ? `Couldn't resolve on ${label}: ${lastNames.join(", ")}` : `Couldn't advance past ${label} (no fixable errors detected).`
        );
      }
      const afterStep = await tabSend(tabId, { type: "WD_DETECT" }, 0);
      aaLog("outer loop continuing after advance", { afterStep });
      if (afterStep && afterStep.step === "submitted") {
        finishLoop("submitted");
        await handleApplicationSubmitted({
          reason: "wd-after-advance-submitted",
          jobId: state.job && state.job.job_id,
        });
        return;
      }
      if (afterStep && afterStep.step === "review") return finishAtReview();
      await delay(600);
    }
    return finishLoop("guard");
  } catch (err) {
    if (loopStopped()) return finishLoop("stopped");
    aaLog("loop ERROR", (err && err.message) || String(err));
    return finishLoop("error", (err && err.message) || String(err));
  }
}

function finishLoop(reason, error) {
  const messages = {
    review: "Reached the Review step - review and submit when you're ready.",
    submitted: "Application submitted, loading next job…",
    done: "Finished the available steps.",
    none: "No Workday application step was detected on this page.",
    stopped: "Auto-advance stopped.",
    stuck: error || "Stopped: could not advance.",
    needs_user: error || "Stopped: some fields need your input.",
    guard: "Stopped after the maximum number of steps.",
    error: error || "Autofill failed.",
  };
  setAutofill({
    running: false,
    done: true,
    autoLoop: true,
    loopStatus: null,
    loopFinished: reason,
    error: reason === "error" ? error || "Autofill failed." : null,
    loopMessage: messages[reason] || "Done.",
  });
}

/** Immediate stop: invalidate runSeq, abort the page engine, unblock the waiter. */
export function stopWorkdayAutofill() {
  wdRunSeq += 1;
  setAutofill({ loopStop: true, loopStatus: "Stopping…" });
  const tabId = state.autofill && state.autofill.tabId;
  if (tabId != null) {
    try {
      void tabBroadcast(tabId, { type: "WD_ABORT", minRunSeq: wdRunSeq });
    } catch {
      /* tab may be gone */
    }
  }
  if (wdStepWaiter) {
    try {
      wdStepWaiter({ aborted: true });
    } catch {
      /* ignore */
    }
  }
  // Single-step (non-loop) runs have no autoAdvanceWorkday to call finishLoop.
  if (state.autofill && state.autofill.running && !state.autofill.autoLoop) {
    setAutofill({
      running: false,
      done: true,
      loopFinished: "stopped",
      loopMessage: "Autofill stopped.",
      loopStatus: null,
    });
  }
}

// If no frame contains a Workday step, none reply - surface that after a wait.
function armWorkdayWatchdog() {
  setTimeout(() => {
    const a = state.autofill;
    if (a.active && a.running && a.engine && a.engine.mode === "workday" && !a.reports.length) {
      setAutofill({ running: false, done: true });
    }
  }, 9000);
}

export async function rerunWorkday() {
  const af = state.autofill;
  if (!af || !af.tabId || !af.engine) return;
  const job = state.job;
  if (!job || !job.job_id) return;
  const tabId = af.tabId;
  const useLoop = state.autoAdvance;
  setAutofill({
    running: true,
    done: false,
    reports: [],
    error: null,
    autoLoop: useLoop,
    loopStop: false,
    loopFinished: null,
    loopMessage: null,
  });
  const resumeSource = (buildPreferences() || {}).resume_source === "original" ? "original" : "tailored";
  try {
    const profile = await getAutofillProfile(job.job_id, resumeSource);
    let resumeFile = null;
    try {
      resumeFile = await api.downloadResumeFile(job.job_id, "resume_pdf");
      debugLog("[workday] resume PDF downloaded:", (resumeFile && resumeFile.filename) || "(unnamed)", "b64=", resumeFile && resumeFile.base64 && resumeFile.base64.length);
    } catch (e) {
      console.warn("[workday] resume PDF download failed:", (e && e.message) || e);
      resumeFile = null;
      toast((e && e.message) || "Could not download the tailored resume PDF for upload.");
    }
    if (useLoop) {
      await autoAdvanceWorkday(tabId, profile, resumeFile);
      return;
    }
    const runSeq = ++wdRunSeq;
    await chrome.tabs.sendMessage(tabId, {
      type: "WD_RUN",
      profile,
      options: { autoAdvance: false, resumeFile, newAttempt: true },
      runSeq,
    });
    armWorkdayWatchdog();
  } catch (err) {
    setAutofill({ running: false, done: true, error: (err && err.message) || String(err) });
  }
}

/** Invalidate any in-flight page run and release the loop's step wait. */
export async function abortWorkdayRun(tabId) {
  wdRunSeq += 1;
  if (tabId != null) {
    try {
      await tabBroadcast(tabId, { type: "WD_ABORT", minRunSeq: wdRunSeq });
    } catch {
      /* tab may be gone */
    }
  }
  if (wdStepWaiter) {
    try {
      wdStepWaiter({ aborted: true });
    } catch {
      /* ignore */
    }
  }
}

const isStale = (msg) => msg.runSeq != null && Number(msg.runSeq) !== wdRunSeq;

/** Messages from the Workday content engine. Returns true when handled. */
export function handleWorkdayMessage(msg) {
  if (!msg.type.startsWith("WD_")) return false;
  const af = state.autofill;
  if (msg.type === "WD_RESOLVE") {
    // After Stop the page waiters are gone; still answer so nothing hangs.
    if (af.loopStop || !af.running) {
      if (af.tabId != null && msg.requestId) {
        chrome.tabs.sendMessage(af.tabId, { type: "WD_RESOLVE_RESULT", requestId: msg.requestId, values: {} }).catch(() => {});
      }
      return true;
    }
    void handleWorkdayResolve(msg);
    return true;
  }
  if (!af.active) return true;
  switch (msg.type) {
    case "WD_PROGRESS":
      if (msg.report) setAutofill({ reports: [...af.reports, msg.report] });
      break;
    case "WD_PHASE":
      if (msg.status) setAutofill({ loopStatus: String(msg.status) });
      break;
    case "WD_AA_LOG":
      if (msg.line) pushAaLog("[page] " + msg.line);
      break;
    case "WD_DONE":
      if (isStale(msg)) break;
      // The auto-advance loop awaits each fill and decides when the run is done.
      if (wdStepWaiter) {
        wdStepWaiter({ reports: msg.reports || [], aborted: !!msg.aborted });
        break;
      }
      if (af.done && af.loopFinished) break;
      setAutofill(
        msg.aborted
          ? { running: false, done: true, loopFinished: "stopped", loopMessage: "Autofill stopped.", loopStatus: null, reports: msg.reports || af.reports }
          : { running: false, done: true, reports: msg.reports || af.reports }
      );
      break;
    case "WD_ERROR":
      if (isStale(msg)) break;
      if (wdStepWaiter) {
        wdStepWaiter({ error: msg.error || "Autofill failed" });
        break;
      }
      if (af.done && af.loopFinished) break;
      setAutofill({ running: false, done: true, error: msg.error || "Autofill failed", reports: msg.reports || af.reports });
      break;
    default:
      break;
  }
  return true;
}
