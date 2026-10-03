import { html, useEffect, useState } from "../../../lib/preact.js";
import { openList } from "../../actions/home.js";
import {
  MIN_DESCRIPTION_CHARS,
  clearFinishedRuns,
  loadLibrary,
  openLibraryResume,
  openStudio,
  setTailorTab,
  tailorFromDescription,
} from "../../actions/tailor.js";
import { formatCount, timeAgo } from "../../format.js";
import { Badge, Button, Empty, Section, Segmented, SkeletonRows, Spinner } from "../components.js";
import { Icon } from "../icons.js";

const SOURCE_LABEL = { job_workflow: "From a job", tailored: "Tailored", manual: "Uploaded" };

function Runs({ runs }) {
  if (!runs.length) return null;
  const finished = runs.some((r) => r.status !== "running");
  return html`<${Section} title="Recent" action=${finished ? html`<button type="button" class="link" onClick=${clearFinishedRuns}>Clear</button>` : null}>
    <div class="rows rows-card">
      ${runs.map(
        (r) => html`<div class="row">
          <span class=${`run-icon run-${r.status}`}>
            ${r.status === "running" ? html`<${Spinner} size=${14} />` : html`<${Icon} name=${r.status === "done" ? "check" : "alert"} size=${14} />`}
          </span>
          <span class="row-body">
            <span class="row-title">${r.title}${r.company ? html`<span class="muted"> at ${r.company}</span>` : null}</span>
            <span class=${`row-sub${r.status === "error" ? " is-danger" : ""}`}>${r.label}</span>
          </span>
        </div>`,
      )}
    </div>
  </${Section}>`;
}

function Paste({ s }) {
  const [text, setText] = useState("");
  const running = s.tailor.runs.some((r) => r.kind === "manual" && r.status === "running");
  const short = text.trim().length < MIN_DESCRIPTION_CHARS;
  const submit = async (e) => {
    e.preventDefault();
    if (await tailorFromDescription(text)) setText("");
  };
  return html`<form class="card paste" onSubmit=${submit}>
    <label class="field">
      <span class="field-label">Job description</span>
      <textarea class="input" rows="8" placeholder="Paste the full posting: responsibilities, requirements, and company details." value=${text} onInput=${(e) => setText(e.currentTarget.value)}></textarea>
    </label>
    <div class="paste-foot">
      <span class="muted small">Saved to your library and set as your active resume.</span>
      <${Button} variant="primary" icon="sparkles" type="submit" busy=${running} disabled=${short}>Tailor</${Button}>
    </div>
  </form>`;
}

function Library({ s }) {
  const [q, setQ] = useState("");
  const { library, libraryLoading } = s.tailor;
  useEffect(() => {
    if (!library) void loadLibrary();
  }, []);
  const search = (e) => {
    e.preventDefault();
    void loadLibrary(q);
  };
  return html`<div class="stack">
    <form class="search" onSubmit=${search}>
      <${Icon} name="search" size=${15} />
      <input type="search" class="input" placeholder="Search by company or role, then press Enter" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} aria-label="Search resumes" />
    </form>
    ${libraryLoading && !library
      ? html`<${SkeletonRows} count=${5} />`
      : library && !library.length
        ? html`<${Empty} icon="file" title="No resumes found">${q ? "Try another company or role." : "Tailored resumes you create show up here."}</${Empty}>`
        : html`<div class=${`rows${libraryLoading ? " is-refreshing" : ""}`} role="list">
            ${(library || []).map(
              (hit) => html`<button type="button" class="row" role="listitem" onClick=${() => openLibraryResume(hit)} title="Open in the resume studio">
                <span class="row-body">
                  <span class="row-title">${hit.job_title || hit.name || "Untitled resume"}</span>
                  <span class="row-sub">${[hit.company, timeAgo(hit.updated_at || hit.created_at)].filter(Boolean).join(" · ")}</span>
                  <span class="row-meta">
                    <${Badge} tone="muted">${SOURCE_LABEL[hit.source] || "Resume"}</${Badge}>
                    ${hit.is_active ? html`<${Badge} tone="ok" dot>Active</${Badge}>` : null}
                    ${hit.has_cover_letter ? html`<span>Cover letter</span>` : null}
                  </span>
                </span>
                <${Icon} name="external" size=${15} class="row-chevron" />
              </button>`,
            )}
          </div>`}
  </div>`;
}

export function TailorView({ s }) {
  const tab = s.tailor.tab;
  const needs = s.home.data ? s.home.data.counts.available : null;
  return html`<div class="stack">
    <${Segmented}
      label="Tailor"
      value=${tab}
      options=${[
        { value: "paste", label: "From a description" },
        { value: "library", label: "Library" },
      ]}
      onChange=${setTailorTab}
    />
    ${tab === "paste"
      ? html`<${Paste} s=${s} />
          <${Runs} runs=${s.tailor.runs} />
          ${needs
            ? html`<button type="button" class="card link-card" onClick=${() => openList("needs")}>
                <span><strong>${formatCount(needs)}</strong> jobs in your pool still need a tailored resume.</span>
                <${Icon} name="chevron" size=${16} />
              </button>`
            : null}`
      : html`<${Library} s=${s} />`}
    <${Button} variant="ghost" icon="external" block onClick=${openStudio}>Open the resume studio</${Button}>
  </div>`;
}
