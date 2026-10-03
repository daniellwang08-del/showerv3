import { html, useState } from "../../../lib/preact.js";
import {
  completeJob,
  dismissReportNotice,
  downloadDoc,
  openJob,
  postToPumble,
  refreshDocs,
  reportExpired,
  runAnalysis,
} from "../../actions/job.js";
import { buildForJob } from "../../actions/tailor.js";
import { WORK_MODE_LABEL, timeAgo, workMode } from "../../format.js";
import { openInWorkTab } from "../../tabs.js";
import { AutofillCard } from "../Autofill.js";
import { Chat } from "../Chat.js";
import { Avatar, Badge, Banner, Button, IconButton, Score, Section, Spinner } from "../components.js";
import { Icon } from "../icons.js";

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(/\n+/)
    .map((v) => v.replace(/^\s*[-*\u2022]\s*/, "").trim())
    .filter(Boolean);
}

function Header({ job }) {
  const snap = job.snapshot || {};
  const mode = workMode(snap.remote_policy);
  const facts = [
    job.location ? { icon: "pin", text: job.location } : null,
    mode && !String(job.location).toLowerCase().includes(mode) ? { icon: "globe", text: WORK_MODE_LABEL[mode] } : null,
    snap.salary_range ? { icon: "briefcase", text: snap.salary_range } : null,
    snap.posted_date ? { icon: "clock", text: `Posted ${timeAgo(snap.posted_date) || snap.posted_date}` } : null,
  ].filter(Boolean);
  return html`<div class="card job-head">
    <div class="job-head-main">
      <${Avatar} label=${job.company || job.title} />
      <div class="job-head-text">
        <h2 class="job-title">${job.title}</h2>
        <p class="job-company">${job.company || "Company not listed"}</p>
      </div>
      <${Score} value=${job.score} size="lg" />
    </div>
    ${facts.length
      ? html`<ul class="job-facts">${facts.map((f) => html`<li><${Icon} name=${f.icon} size=${13} />${f.text}</li>`)}</ul>`
      : null}
    <div class="job-head-actions">
      ${job.applied ? html`<${Badge} tone="ok" dot>Applied ${timeAgo(job.appliedAt) || ""}</${Badge}>` : null}
      ${job.pumblePosted ? html`<${Badge} tone="muted">On Pumble</${Badge}>` : null}
      <span class="topbar-spacer"></span>
      ${job.url ? html`<${Button} size="sm" variant="ghost" icon="external" onClick=${() => openInWorkTab(job.url)}>Open posting</${Button}>` : null}
    </div>
  </div>`;
}

function DocButton({ ready, label, type, name }) {
  return html`<${Button} size="sm" variant="secondary" icon="download" disabled=${!ready} title=${ready ? `Download ${name}` : `${name} not ready`} onClick=${() => downloadDoc(type, name)}>${label}</${Button}>`;
}

function Documents({ job, s }) {
  const d = job.docs;
  const hasResume = d.resumePdf || d.resumeDocx;
  const hasCover = d.coverPdf || d.coverDocx;
  const status = String(d.contentStatus || "").toLowerCase();
  const building = ["queued", "pending", "processing", "running", "generating"].includes(status) || s.tailor.runs.some((r) => r.jobId === job.job_id && r.status !== "error");
  const failed = status === "failed" || !!d.buildError;
  return html`<${Section}
    title="Documents"
    action=${hasResume || building ? html`<${IconButton} icon="refresh" size=${14} label="Check again" onClick=${() => refreshDocs()} />` : null}
  >
    <div class="card docs">
      ${hasResume || hasCover
        ? html`<div class="docs-grid">
            <span class="docs-label">Resume</span>
            <div class="docs-buttons">
              <${DocButton} ready=${d.resumePdf} label="PDF" type="resume_pdf" name="Resume PDF" />
              <${DocButton} ready=${d.resumeDocx} label="Word" type="resume_docx" name="Resume Word file" />
            </div>
            <span class="docs-label">Cover letter</span>
            <div class="docs-buttons">
              <${DocButton} ready=${d.coverPdf} label="PDF" type="cover_letter_pdf" name="Cover letter PDF" />
              <${DocButton} ready=${d.coverDocx} label="Word" type="cover_letter_docx" name="Cover letter Word file" />
            </div>
          </div>`
        : null}
      ${building && !(hasResume && hasCover)
        ? html`<p class="docs-status"><${Spinner} size=${13} />Writing your tailored ${hasResume ? "cover letter" : "resume"}. This updates on its own.</p>`
        : null}
      ${failed && !building ? html`<p class="docs-status is-danger"><${Icon} name="alert" size=${14} />The last build failed${d.buildError ? `: ${d.buildError}` : "."}</p>` : null}
      ${!hasResume && !building
        ? html`<div class="docs-empty">
            <p>${job.ready ? "No tailored resume for this job yet. Autofill will use your original resume." : "Analyze the job first, then build a tailored resume."}</p>
            ${job.ready
              ? html`<${Button} size="sm" variant="secondary" icon="sparkles" onClick=${() => buildForJob({ id: job.job_id, title: job.title, company: job.company })}>${failed ? "Try again" : "Build resume"}</${Button}>`
              : null}
          </div>`
        : null}
    </div>
  </${Section}>`;
}

function Description({ job }) {
  const [open, setOpen] = useState(false);
  const snap = job.snapshot || {};
  if (!job.ready) {
    return html`<${Section} title="About the job">
      <div class="card analyze">
        <p>${job.analyzing ? "Reading the posting and scoring your fit." : "This job has not been analyzed yet. Analysis scores your fit and unlocks a tailored resume."}</p>
        <${Button} variant="secondary" size="sm" icon="sparkles" busy=${job.analyzing} onClick=${runAnalysis}>${job.analyzing ? "Analyzing" : "Analyze job"}</${Button}>
      </div>
    </${Section}>`;
  }
  const blocks = [
    ["Responsibilities", asList(snap.responsibilities)],
    ["Requirements", asList(snap.requirements)],
    ["Benefits", asList(snap.benefits)],
  ].filter(([, items]) => items.length);
  const meta = [snap.employment_type, snap.experience_level, snap.industry].filter(Boolean);
  return html`<${Section} title="About the job" action=${html`<button type="button" class="link" onClick=${() => setOpen(!open)}>${open ? "Show less" : "Show all"}</button>`}>
    <div class=${`card jd${open ? " is-open" : ""}`}>
      ${meta.length ? html`<div class="jd-meta">${meta.map((m) => html`<${Badge} tone="muted">${m}</${Badge}>`)}</div>` : null}
      ${blocks.length
        ? blocks.map(
            ([title, items]) => html`<div class="jd-block">
              <h3>${title}</h3>
              <ul>${(open ? items : items.slice(0, 3)).map((t) => html`<li>${t}</li>`)}</ul>
              ${!open && items.length > 3 ? html`<p class="muted small">${items.length - 3} more</p>` : null}
            </div>`,
          )
        : html`<p class="jd-text">${String(snap.description || "No description available.").slice(0, open ? 20000 : 420)}</p>`}
    </div>
  </${Section}>`;
}

function ActionBar({ job, s }) {
  const [menu, setMenu] = useState(false);
  const pumble = s.home.data && s.home.data.pumble_configured;
  return html`<footer class="actionbar">
    <div class="actionbar-more">
      <${IconButton} icon="layers" label="More actions" active=${menu} onClick=${() => setMenu(!menu)} />
      ${menu
        ? html`<div class="menu" role="menu" onClick=${() => setMenu(false)}>
            <button type="button" role="menuitem" onClick=${reportExpired}><${Icon} name="flag" size=${15} />Report expired posting</button>
            ${pumble
              ? html`<button type="button" role="menuitem" disabled=${s.postingToPumble || job.pumblePosted} onClick=${() => postToPumble([job.job_id])}>
                  <${Icon} name="message" size=${15} />${job.pumblePosted ? "Already on Pumble" : "Post to Pumble"}
                </button>`
              : null}
            ${!job.applied ? html`<button type="button" role="menuitem" onClick=${() => completeJob({ next: false })}><${Icon} name="check" size=${15} />Mark applied and close</button>` : null}
          </div>`
        : null}
    </div>
    <${Button} variant="primary" icon=${job.applied ? "chevron" : "check"} block onClick=${() => completeJob({ next: true })}>
      ${job.applied ? "Next job" : "Applied, next job"}
    </${Button}>
  </footer>`;
}

export function JobView({ s }) {
  const job = s.job;
  if (s.jobError) {
    return html`<div class="stack">
      <${Banner} tone="danger">${s.jobError}</${Banner}>
      ${s.applyContext && s.applyContext.seen.length
        ? html`<${Button} variant="secondary" icon="refresh" onClick=${() => openJob(s.applyContext.seen[s.applyContext.seen.length - 1])}>Try again</${Button}>`
        : null}
    </div>`;
  }
  if (!job) return html`<div class="center-fill"><${Spinner} size=${22} /></div>`;
  return html`<div class="job">
    <div class="stack job-scroll">
      ${s.reportNotice
        ? html`<${Banner} tone="ok" onDismiss=${dismissReportNotice}>
            Reported ${s.reportNotice.title}${s.reportNotice.company ? ` at ${s.reportNotice.company}` : ""} as expired.
          </${Banner}>`
        : null}
      <${Header} job=${job} />
      <${AutofillCard} s=${s} />
      <${Documents} job=${job} s=${s} />
      <${Section} title="Assistant"><${Chat} s=${s} /></${Section}>
      <${Description} job=${job} />
    </div>
    <${ActionBar} job=${job} s=${s} />
  </div>`;
}
