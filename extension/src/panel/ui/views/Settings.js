import { html, useEffect, useLayoutEffect, useState } from "../../../lib/preact.js";
import * as storage from "../../../storage.js";
import { changeServer, refreshAccount, savePreference, signOut, updateAccountSetting } from "../../actions/session.js";
import { openMatchingPreferences } from "../../actions/tailor.js";
import { setState } from "../../state.js";
import { toast } from "../../toast.js";
import { ANSWER_TYPES, CHAT_STYLES } from "../Chat.js";
import { Badge, Button, IconButton, Section, Segmented, Select, Toggle } from "../components.js";

const MIN_SCORE_PRESETS = [0, 50, 70, 80, 90];

const PIPELINE_OPTIONS = [
  { value: "full", label: "Score and build resume" },
  { value: "match", label: "Score only" },
  { value: "extract", label: "Read only" },
];

function usesOriginalResume(settings) {
  return settings.application_resume_source === "original";
}

function pipelineOptions(settings) {
  if (!usesOriginalResume(settings)) return PIPELINE_OPTIONS;
  return PIPELINE_OPTIONS.map((o) => (o.value === "full" ? { ...o, label: "Score (original resume)" } : o));
}

/** Read-only: the mode is account-wide and changing it affects scoring, so it lives on the web app. */
function ResumeSource({ settings }) {
  const original = usesOriginalResume(settings);
  return html`<div class="setting-note">
    <${Row}
      label="Resume for applications"
      hint=${original
        ? "Your original resume. NAO scores and ranks jobs, then uploads your resume as it is and fills every application from it."
        : "Tailored per job. NAO uploads the tailored resume and fills answers from it, and uses your original resume for jobs that have none yet."}
    >
      <${Badge} tone=${original ? "muted" : "brand"}>${original ? "Original" : "Tailored"}</${Badge}>
    </${Row}>
    ${original
      ? html`<p class="setting-hint">
          To apply with a resume tailored to each job, open Preferences on the web app, go to Matching, and set
          Resume for applications to Tailored resume per job. Turn on Prepare documents automatically to build one for
          every newly scored job, or use Build resume on a single job. Tailored resumes keep your real employers, titles,
          and dates, and rephrase your experience around each job description.
        </p>`
      : html`<p class="setting-hint">
          This is an account setting so scoring and autofill stay in step. Change it in Preferences on the web app,
          under Matching.
        </p>`}
    <${Button} size="sm" variant="secondary" icon="external" onClick=${openMatchingPreferences}>Open Preferences</${Button}>
  </div>`;
}

function Row({ label, hint, children }) {
  return html`<div class="setting">
    <div class="setting-copy">
      <span class="setting-label">${label}</span>
      ${hint ? html`<span class="setting-hint">${hint}</span>` : null}
    </div>
    <div class="setting-control">${children}</div>
  </div>`;
}

function confirm(modal) {
  return new Promise((resolve) => {
    setState({
      modal: {
        busy: false,
        ...modal,
        onConfirm: () => {
          setState({ modal: null });
          resolve(true);
        },
        onCancel: () => resolve(false),
      },
    });
  });
}

function MinScore({ s }) {
  const account = s.cache && s.cache.settings ? s.cache.settings.min_match_score : null;
  const current = Number(account ?? s.minScore ?? 0);
  const pick = async (score) => {
    if (score === current) return;
    if (score > current) {
      const ok = await confirm({
        title: `Hide jobs below ${score}?`,
        message: "Jobs that score lower are hidden from your pool on every device. You can lower this again at any time.",
        confirmLabel: "Hide lower scores",
      });
      if (!ok) return;
    }
    const err = await updateAccountSetting({ min_match_score: score });
    if (err) return toast(err, "danger");
    await savePreference("minScore", score);
    toast(score ? `Showing jobs scoring ${score} or more.` : "Showing jobs at every score.", "ok");
  };
  return html`<${Segmented}
    label="Minimum match score"
    value=${current}
    options=${MIN_SCORE_PRESETS.map((v) => ({ value: v, label: v ? `${v}+` : "All" }))}
    onChange=${pick}
  />`;
}

function DailyGoal({ value }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = async (raw) => {
    const next = await savePreference("dailyApplyTarget", raw);
    setDraft(String(next));
  };
  return html`<div class="stepper">
    <${IconButton} icon="minus" label="Decrease" size=${14} onClick=${() => commit(Number(draft) - 1)} />
    <input class="input" type="number" min="0" max="200" inputmode="numeric" value=${draft} aria-label="Daily goal"
      onInput=${(e) => setDraft(e.currentTarget.value)} onChange=${(e) => commit(e.currentTarget.value)} />
    <${IconButton} icon="plus" label="Increase" size=${14} onClick=${() => commit(Number(draft) + 1)} />
  </div>`;
}

function Hotkey({ value }) {
  const [recording, setRecording] = useState(false);
  useLayoutEffect(() => {
    if (!recording) return undefined;
    const onKey = async (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setRecording(false);
        return;
      }
      const combo = storage.askHotkeyFromKeyboardEvent(e);
      if (!combo) return;
      e.preventDefault();
      e.stopPropagation();
      const saved = await savePreference("askHotkey", combo);
      setRecording(false);
      toast(`Ask hotkey set to ${storage.formatAskHotkey(saved)}.`, "ok");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);
  return html`<div class="hotkey">
    <kbd class=${recording ? "is-recording" : ""}>${recording ? "Press keys" : storage.formatAskHotkey(value)}</kbd>
    <${Button} size="sm" variant=${recording ? "primary" : "secondary"} onClick=${() => setRecording(!recording)}>${recording ? "Cancel" : "Change"}</${Button}>
    ${!recording ? html`<button type="button" class="link" onClick=${() => savePreference("askHotkey", storage.DEFAULT_ASK_HOTKEY)}>Reset</button>` : null}
  </div>`;
}

function Server({ backendUrl }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(backendUrl);
  const save = async (url) => {
    const err = await changeServer(url);
    if (err) return toast(err, "danger");
    setEditing(false);
  };
  if (!editing) {
    return html`<div class="setting-inline"><code>${backendUrl}</code><button type="button" class="link" onClick=${() => { setValue(backendUrl); setEditing(true); }}>Change</button></div>`;
  }
  return html`<div class="setting-inline">
    <input class="input" type="url" value=${value} onInput=${(e) => setValue(e.currentTarget.value)} aria-label="Server address" />
    <${Button} size="sm" variant="secondary" onClick=${() => save(value.trim() || null)}>Save</${Button}>
    <button type="button" class="link" onClick=${() => save(null)}>Default</button>
  </div>`;
}

export function SettingsView({ s }) {
  const settings = (s.cache && s.cache.settings) || {};
  const [strategy, setStrategy] = useState(s.answerStrategy);

  const toggleAutoSubmit = async (on) => {
    if (on) {
      const ok = await confirm({
        title: "Submit Workday applications for you?",
        message: "When autofill reaches the Review step, NAO clicks Submit without waiting for you. Leave this off to review every application yourself.",
        confirmLabel: "Turn on auto-submit",
        tone: "danger",
      });
      if (!ok) return;
    }
    await savePreference("autoSubmit", on);
  };

  return html`<div class="stack settings">
    <${Section} title="Account">
      <div class="card">
        <${Row} label=${s.user ? s.user.email : ""} hint="Signed in">
          <${Button} size="sm" variant="ghost" icon="logout" onClick=${signOut}>Sign out</${Button}>
        </${Row}>
        <${Row} label="Profile and settings" hint="Pull the latest from the web app">
          <${Button} size="sm" variant="secondary" icon="refresh" onClick=${() => refreshAccount()}>Refresh</${Button}>
        </${Row}>
      </div>
    </${Section}>

    <${Section} title="Matching">
      <div class="card">
        <${Row} label="Minimum match score" hint="Synced with your account. Lower-scoring jobs are hidden." />
        <${MinScore} s=${s} />
        <${Row} label="Daily goal" hint="Applications per day, shown on Home. 0 hides it.">
          <${DailyGoal} value=${s.dailyApplyTarget} />
        </${Row}>
        <${Row} label="Jobs you add by link" hint="What NAO does after you add a link">
          <${Select}
            label="Jobs you add by link"
            value=${settings.manual_submit_pipeline || "full"}
            options=${pipelineOptions(settings)}
            onChange=${async (v) => {
              const err = await updateAccountSetting({ manual_submit_pipeline: v });
              toast(err || "Saved.", err ? "danger" : "ok");
            }}
          />
        </${Row}>
      </div>
    </${Section}>

    <${Section} title="Autofill">
      <div class="card">
        <${ResumeSource} settings=${settings} />
        <${Toggle}
          label="Continue through Workday steps"
          hint="Fills each step and moves on until Review."
          checked=${s.autoAdvance}
          onChange=${(on) => savePreference("autoAdvance", on)}
        />
        <${Toggle}
          label="Submit on Workday Review"
          hint="Off means you always press Submit yourself."
          checked=${s.autoSubmit}
          disabled=${!s.autoAdvance}
          onChange=${toggleAutoSubmit}
        />
        <label class="field">
          <span class="field-label">Guidance for written answers</span>
          <textarea class="input" rows="3" placeholder="For example: keep answers short and mention my React work." value=${strategy}
            onInput=${(e) => setStrategy(e.currentTarget.value)}
            onChange=${async (e) => {
              await savePreference("answerStrategy", e.currentTarget.value);
              toast("Saved.", "ok");
            }}></textarea>
        </label>
      </div>
    </${Section}>

    <${Section} title="Assistant">
      <div class="card">
        <${Row} label="Answer length">
          <${Select} label="Answer length" value=${s.chatStyle} options=${CHAT_STYLES} onChange=${(v) => savePreference("chatStyle", v)} />
        </${Row}>
        <${Row} label="Answer format">
          <${Select} label="Answer format" value=${s.answerType} options=${ANSWER_TYPES} onChange=${(v) => savePreference("answerType", v)} />
        </${Row}>
        <${Row} label="Ask hotkey" hint="Select a question on the page and press it to get an answer.">
          <${Hotkey} value=${s.askHotkey} />
        </${Row}>
      </div>
    </${Section}>

    <${Section} title="Lists">
      <div class="card">
        <${Row} label="Jobs per page">
          <${Select}
            label="Jobs per page"
            value=${s.pageSize}
            options=${storage.PAGE_SIZES.map((n) => ({ value: n, label: String(n) }))}
            onChange=${(v) => savePreference("pageSize", Number(v))}
          />
        </${Row}>
      </div>
    </${Section}>

    <${Section} title="Server">
      <div class="card"><${Server} backendUrl=${s.backendUrl} /></div>
    </${Section}>

    <p class="muted small center">NAO ${chrome.runtime.getManifest().version}</p>
  </div>`;
}
