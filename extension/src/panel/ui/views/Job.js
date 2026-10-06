import { html } from "../../../lib/preact.js";
import {
  completeJob,
  dismissReportNotice,
  downloadDoc,
  openJob,
  postToPumble,
  refreshDocs,
  reportExpired,
  runAnalysis,
  skipJob,
} from "../../actions/job.js";
import { buildForJob } from "../../actions/tailor.js";
import { WORK_MODE_LABEL, timeAgo, workMode } from "../../format.js";
import { openInWorkTab } from "../../tabs.js";
import { AutofillCard } from "../Autofill.js";
import { Chat } from "../Chat.js";
import { Avatar, Badge, Banner, Button, IconButton, Score, Spinner } from "../components.js";
import { Icon } from "../icons.js";

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
      ${job.url ? html`<${IconButton} icon="external" size=${15} label="Open posting" onClick=${() => openInWorkTab(job.url)} />` : null}
      <${Score} value=${job.score} size="lg" />
    </div>
    ${facts.length || job.applied || job.pumblePosted
      ? html`<ul class="job-facts">
          ${job.applied ? html`<li><${Badge} tone="ok" dot>Applied ${timeAgo(job.appliedAt) || ""}</${Badge}></li>` : null}
          ${job.pumblePosted ? html`<li><${Badge} tone="muted">On Pumble</${Badge}></li>` : null}
          ${facts.map((f) => html`<li><${Icon} name=${f.icon} size=${13} />${f.text}</li>`)}
        </ul>`
      : null}
  </div>`;
}

function DocFile({ ready, kind, type, name }) {
  return html`<button
    type="button"
    class=${`doc-file doc-${kind}`}
    disabled=${!ready}
    title=${ready ? `Download ${name}` : `${name} not ready`}
    aria-label=${ready ? `Download ${name}` : `${name} not ready`}
    onClick=${() => downloadDoc(type, name)}
  >
    <${Icon} name="file" size=${20} />
    <span class="doc-tag">${kind === "pdf" ? "PDF" : "W"}</span>
  </button>`;
}

function Documents({ job, s }) {
  const d = job.docs;
  const hasResume = d.resumePdf || d.resumeDocx;
  const hasCover = d.coverPdf || d.coverDocx;
  const status = String(d.contentStatus || "").toLowerCase();
  const building = ["queued", "pending", "processing", "running", "generating"].includes(status) || s.tailor.runs.some((r) => r.jobId === job.job_id && r.status !== "error");
  const failed = status === "failed" || !!d.buildError;
  const original = ((s.cache && s.cache.settings) || {}).application_resume_source === "original";
  const build = () => buildForJob({ id: job.job_id, title: job.title, company: job.company });

  let body;
  if (hasResume || hasCover) {
    body = html`<div class="docs-files">
      <span class="docs-label">Resume</span>
      <${DocFile} ready=${d.resumePdf} kind="pdf" type="resume_pdf" name="Resume PDF" />
      <${DocFile} ready=${d.resumeDocx} kind="word" type="resume_docx" name="Resume Word file" />
      <span class="docs-sep" aria-hidden="true"></span>
      <span class="docs-label">Cover letter</span>
      <${DocFile} ready=${d.coverPdf} kind="pdf" type="cover_letter_pdf" name="Cover letter PDF" />
      <${DocFile} ready=${d.coverDocx} kind="word" type="cover_letter_docx" name="Cover letter Word file" />
    </div>`;
  } else if (building) {
    body = html`<p class="docs-status"><${Spinner} size=${13} />Writing your tailored resume.</p>`;
  } else if (!job.ready) {
    body = html`<p class="docs-status">${job.analyzing ? "Scoring your fit." : "Not analyzed yet."}</p>
      <${Button} size="sm" variant="secondary" icon="sparkles" busy=${job.analyzing} onClick=${runAnalysis}>${job.analyzing ? "Analyzing" : "Analyze"}</${Button}>`;
  } else {
    body = html`<p class="docs-status" title=${original ? "Autofill uses your original resume, as set in Preferences under Matching." : "Autofill will use your original resume."}>No tailored resume yet.</p>
      <${Button} size="sm" variant="secondary" icon="sparkles" onClick=${build}>${failed ? "Try again" : "Build"}</${Button}>`;
  }

  return html`<div class="card docs">
    <div class="docs-row">
      ${body}
      ${hasResume || building ? html`<${IconButton} icon="refresh" size=${14} label="Check documents again" onClick=${() => refreshDocs()} />` : null}
    </div>
    ${building && hasResume && !hasCover
      ? html`<p class="docs-note"><${Spinner} size=${12} />Writing your cover letter.</p>`
      : null}
    ${failed && !building ? html`<p class="docs-note is-danger"><${Icon} name="alert" size=${13} />The last build failed${d.buildError ? `: ${d.buildError}` : "."}</p>` : null}
    ${original && hasResume ? html`<p class="docs-note">Autofill uploads your original resume (Preferences, Matching).</p>` : null}
  </div>`;
}

function ActionBar({ job, s }) {
  const pumble = s.home.data && s.home.data.pumble_configured;
  return html`<footer class="actionbar">
    <${Button} variant="secondary" icon="clock" disabled=${s.skipping} title="Skip for now. It stays in In progress so you can apply later." onClick=${skipJob}>Skip</${Button}>
    <${Button} variant="ghost" icon="flag" title="Report this posting as expired" onClick=${reportExpired}>Expired</${Button}>
    ${pumble
      ? html`<${IconButton}
          icon="message"
          label=${job.pumblePosted ? "Already on Pumble" : "Post to Pumble"}
          disabled=${s.postingToPumble || job.pumblePosted}
          onClick=${() => postToPumble([job.job_id])}
        />`
      : null}
    <${Button} variant="primary" icon=${job.applied ? "chevron" : "check"} block onClick=${() => completeJob({ next: true })}>
      ${job.applied ? "Next job" : "Applied, next"}
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
    <div class="job-top">
      ${s.reportNotice
        ? html`<${Banner} tone="ok" onDismiss=${dismissReportNotice}>
            Reported ${s.reportNotice.title}${s.reportNotice.company ? ` at ${s.reportNotice.company}` : ""} as expired.
          </${Banner}>`
        : null}
      <${Header} job=${job} />
      <${AutofillCard} s=${s} />
      <${Documents} job=${job} s=${s} />
    </div>
    <div class="job-chat"><${Chat} s=${s} /></div>
    <${ActionBar} job=${job} s=${s} />
  </div>`;
}
