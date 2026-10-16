import { html } from "../../lib/preact.js";
import {
  MIN_DESCRIPTION_CHARS,
  closeQuickApply,
  openQuickApply,
  readFromTab,
  submitQuickApply,
  updateQuickApply,
} from "../actions/quickApply.js";
import { openMatchingPreferences } from "../actions/tailor.js";
import { formatCount } from "../format.js";
import { Banner, Button, IconButton, Spinner } from "./components.js";
import { Icon } from "./icons.js";

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function Steps({ original }) {
  const steps = [
    { icon: "chart", text: "Scores your fit" },
    { icon: "file", text: original ? "Writes a cover letter, your resume goes as is" : "Writes a tailored resume and cover letter" },
    { icon: "message", text: "Autofill and the assistant help you apply" },
  ];
  return html`<ol class="quick-steps">
    ${steps.map((st) => html`<li><span class="quick-step-icon"><${Icon} name=${st.icon} size=${12} /></span>${st.text}</li>`)}
  </ol>`;
}

function Collapsed() {
  return html`<button type="button" class="card quick quick-collapsed" onClick=${() => openQuickApply()}>
    <span class="quick-icon"><${Icon} name="wand" size=${17} /></span>
    <span class="quick-copy">
      <span class="quick-title">Quick apply</span>
      <span class="quick-sub">From LinkedIn or any site: paste the job description and NAO prepares the rest.</span>
    </span>
    <span class="quick-cta"><${Icon} name="plus" size=${14} />Paste job</span>
  </button>`;
}

export function QuickApply({ q, settings }) {
  if (!q.open) return html`<${Collapsed} />`;
  const original = (settings || {}).application_resume_source === "original";
  const length = q.description.trim().length;
  const short = length > 0 && length < MIN_DESCRIPTION_CHARS;
  const host = hostOf(q.url);
  const submit = (e) => {
    e.preventDefault();
    void submitQuickApply();
  };
  return html`<form class="card quick quick-open" onSubmit=${submit}>
    <header class="quick-head">
      <span class="quick-icon"><${Icon} name="wand" size=${17} /></span>
      <span class="quick-copy">
        <span class="quick-title">Quick apply</span>
        <span class="quick-sub">For LinkedIn and sites NAO can't read on its own.</span>
      </span>
      <${IconButton} icon="x" label="Close quick apply" size=${15} disabled=${q.busy} onClick=${closeQuickApply} />
    </header>

    <div class="quick-input">
      <textarea
        class="input quick-text"
        rows="7"
        placeholder="Paste the full job description: role, company, responsibilities and requirements."
        value=${q.description}
        disabled=${q.busy}
        onInput=${(e) => updateQuickApply({ description: e.currentTarget.value })}
        onKeyDown=${(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(e);
        }}
      ></textarea>
      <div class="quick-input-foot">
        <button type="button" class="quick-chip" disabled=${q.busy || q.reading} onClick=${() => readFromTab()} title="Read the posting open in this window. Select text first to use just that part.">
          ${q.reading ? html`<${Spinner} size=${12} />` : html`<${Icon} name="file" size=${12} />`}${q.reading ? "Reading" : "Read this page"}
        </button>
        <span class=${`quick-count${short ? " is-short" : ""}`}>
          ${length ? `${formatCount(length)} characters${short ? `, add a bit more` : ""}` : "Ctrl+Enter to prepare"}
        </span>
      </div>
    </div>

    ${q.details
      ? html`<div class="quick-details">
          <div class="quick-grid">
            <input class="input" placeholder="Job title" aria-label="Job title" value=${q.title} disabled=${q.busy} onInput=${(e) => updateQuickApply({ title: e.currentTarget.value })} />
            <input class="input" placeholder="Company" aria-label="Company" value=${q.company} disabled=${q.busy} onInput=${(e) => updateQuickApply({ company: e.currentTarget.value })} />
          </div>
          <input class="input" type="url" placeholder="Posting link (optional)" aria-label="Posting link" value=${q.url} disabled=${q.busy} onInput=${(e) => updateQuickApply({ url: e.currentTarget.value })} />
          <p class="quick-hint">Optional. Left empty, NAO reads the title and company from the description.</p>
        </div>`
      : html`<div class="quick-meta">
          ${host
            ? html`<span class="quick-link" title=${q.url}><${Icon} name="globe" size=${12} />${host}
                <button type="button" class="quick-link-x" aria-label="Remove posting link" onClick=${() => updateQuickApply({ url: "" })}><${Icon} name="x" size=${11} /></button>
              </span>`
            : null}
          <button type="button" class="link" onClick=${() => updateQuickApply({ details: true })}>Add title, company or link</button>
        </div>`}

    <${Steps} original=${original} />

    ${q.error ? html`<${Banner} tone="danger">${q.error}</${Banner}>` : null}

    <footer class="quick-foot">
      <button
        type="button"
        class=${`quick-mode${original ? "" : " is-tailored"}`}
        title="Change which resume applications use in Preferences under Matching"
        onClick=${() => openMatchingPreferences()}
      >
        <${Icon} name=${original ? "file" : "sparkles"} size=${12} />${original ? "Original resume" : "Tailored resume"}
      </button>
      <${Button} variant="primary" icon="sparkles" type="submit" busy=${q.busy} disabled=${length < MIN_DESCRIPTION_CHARS}>
        ${q.busy ? "Preparing" : "Prepare application"}
      </${Button}>
    </footer>
  </form>`;
}
